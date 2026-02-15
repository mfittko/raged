"""Postgres database client using asyncpg connection pool."""

import logging
import os
from typing import Any

import asyncpg

from src.config import DATABASE_URL

logger = logging.getLogger(__name__)

# Global connection pool
_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    """Get or create the asyncpg connection pool.
    
    Returns:
        asyncpg connection pool
    """
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            DATABASE_URL,
            min_size=2,
            max_size=10,
            command_timeout=60,
        )
        logger.info("Database connection pool created")
    return _pool


async def close_pool() -> None:
    """Close the connection pool."""
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
        logger.info("Database connection pool closed")


async def dequeue_task(worker_id: str) -> dict[str, Any] | None:
    """Dequeue a task from the task_queue using SKIP LOCKED.
    
    This implements the worker dequeue pattern with automatic lease management.
    
    Args:
        worker_id: Unique identifier for this worker instance
        
    Returns:
        Task dictionary if a task was dequeued, None if no tasks available
    """
    pool = await get_pool()
    
    query = """
        WITH next AS (
            SELECT id FROM task_queue
            WHERE queue = 'enrichment' AND status = 'pending' AND run_after <= now()
            ORDER BY run_after, created_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        UPDATE task_queue SET 
            status = 'processing',
            started_at = now(),
            lease_expires_at = now() + interval '5 minutes',
            leased_by = $1
        FROM next 
        WHERE task_queue.id = next.id
        RETURNING 
            task_queue.id,
            task_queue.payload,
            task_queue.attempt,
            task_queue.created_at
    """
    
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, worker_id)
        
        if row is None:
            return None
            
        # Convert payload from JSONB to dict
        payload = dict(row["payload"])
        
        # Add task metadata
        task = {
            **payload,
            "taskId": str(row["id"]),
            "attempt": row["attempt"],
        }
        
        return task


async def complete_task(task_id: str) -> None:
    """Mark a task as completed.
    
    Args:
        task_id: Task ID (UUID as string)
    """
    pool = await get_pool()
    
    query = """
        UPDATE task_queue
        SET status = 'completed',
            completed_at = now(),
            lease_expires_at = NULL,
            leased_by = NULL
        WHERE id = $1
    """
    
    async with pool.acquire() as conn:
        await conn.execute(query, task_id)


async def fail_task(task_id: str, error_msg: str, attempt: int, max_attempts: int) -> None:
    """Mark a task as failed or retry it.
    
    If attempt < max_attempts, the task is reset to pending for retry.
    Otherwise, it's marked as dead (terminal failure).
    
    Args:
        task_id: Task ID (UUID as string)
        error_msg: Error message
        attempt: Current attempt number
        max_attempts: Maximum retry attempts
    """
    pool = await get_pool()
    
    if attempt < max_attempts:
        # Retry with exponential backoff: 2, 4, 8, 16, 32, 60 seconds
        backoff_seconds = min(2 ** attempt, 60)
        
        query = """
            UPDATE task_queue
            SET status = 'pending',
                attempt = $2,
                run_after = now() + ($3 || ' seconds')::interval,
                lease_expires_at = NULL,
                leased_by = NULL,
                error = $4
            WHERE id = $1
        """
        
        async with pool.acquire() as conn:
            await conn.execute(query, task_id, attempt + 1, backoff_seconds, error_msg)
        
        logger.info(f"Task {task_id} re-queued for retry {attempt + 1}/{max_attempts}")
    else:
        # Terminal failure - mark as dead
        query = """
            UPDATE task_queue
            SET status = 'dead',
                completed_at = now(),
                lease_expires_at = NULL,
                leased_by = NULL,
                error = $2
            WHERE id = $1
        """
        
        async with pool.acquire() as conn:
            await conn.execute(query, task_id, error_msg)
        
        logger.error(f"Task {task_id} moved to dead status after {max_attempts} attempts")


async def recover_stale_leases() -> int:
    """Recover tasks with expired leases (watchdog pattern).
    
    This resets processing tasks with expired leases back to pending status.
    
    Returns:
        Number of tasks recovered
    """
    pool = await get_pool()
    
    query = """
        UPDATE task_queue
        SET status = 'pending',
            lease_expires_at = NULL,
            leased_by = NULL,
            run_after = now()
        WHERE status = 'processing'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at < now()
    """
    
    async with pool.acquire() as conn:
        result = await conn.execute(query)
        
        # Extract number of rows affected from result string like "UPDATE 3"
        count = int(result.split()[-1]) if result and result.split() else 0
        
        if count > 0:
            logger.warning(f"Recovered {count} stale task(s) with expired leases")
        
        return count


async def update_chunk_status(chunk_id: str, document_id: str, chunk_index: int, status: str) -> None:
    """Update enrichment status of a chunk.
    
    Args:
        chunk_id: Legacy Qdrant ID (baseId:chunkIndex format)
        document_id: Document UUID
        chunk_index: Chunk index
        status: New status (pending, processing, enriched, failed)
    """
    pool = await get_pool()
    
    query = """
        UPDATE chunks
        SET enrichment_status = $3
        WHERE document_id = $1 AND chunk_index = $2
    """
    
    async with pool.acquire() as conn:
        await conn.execute(query, document_id, chunk_index, status)


async def update_chunk_tier2(document_id: str, chunk_index: int, tier2_data: dict) -> None:
    """Update tier2 metadata for a chunk.
    
    Args:
        document_id: Document UUID
        chunk_index: Chunk index
        tier2_data: Tier 2 enrichment data
    """
    pool = await get_pool()
    
    query = """
        UPDATE chunks
        SET tier2_meta = $3
        WHERE document_id = $1 AND chunk_index = $2
    """
    
    async with pool.acquire() as conn:
        await conn.execute(query, document_id, chunk_index, tier2_data)


async def update_chunk_tier3(document_id: str, chunk_index: int, tier3_data: dict) -> None:
    """Update tier3 metadata for a chunk and mark as enriched.
    
    Args:
        document_id: Document UUID
        chunk_index: Chunk index
        tier3_data: Tier 3 enrichment data
    """
    pool = await get_pool()
    
    query = """
        UPDATE chunks
        SET tier3_meta = $3,
            enrichment_status = 'enriched',
            enriched_at = now()
        WHERE document_id = $1 AND chunk_index = $2
    """
    
    async with pool.acquire() as conn:
        await conn.execute(query, document_id, chunk_index, tier3_data)


async def get_chunks_text(document_id: str, total_chunks: int) -> list[str]:
    """Get text from all chunks of a document.
    
    Args:
        document_id: Document UUID
        total_chunks: Expected number of chunks
        
    Returns:
        List of chunk texts in order by chunk_index
    """
    pool = await get_pool()
    
    query = """
        SELECT chunk_index, text
        FROM chunks
        WHERE document_id = $1
        ORDER BY chunk_index
    """
    
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, document_id)
        
        # Build text list preserving order
        texts = [""] * total_chunks
        for row in rows:
            idx = row["chunk_index"]
            if 0 <= idx < total_chunks:
                texts[idx] = row["text"]
        
        return texts


async def upsert_entity(name: str, entity_type: str, description: str = "") -> str:
    """Create or update an entity.
    
    Args:
        name: Entity name
        entity_type: Entity type
        description: Entity description
        
    Returns:
        Entity ID (UUID as string)
    """
    pool = await get_pool()
    
    query = """
        INSERT INTO entities (name, type, description)
        VALUES ($1, $2, $3)
        ON CONFLICT (name) DO UPDATE
        SET type = EXCLUDED.type,
            description = EXCLUDED.description,
            last_seen = now()
        RETURNING id
    """
    
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, name, entity_type, description)
        return str(row["id"])


async def add_document_mention(document_id: str, entity_id: str) -> None:
    """Create or update a document-entity mention.
    
    Args:
        document_id: Document UUID
        entity_id: Entity UUID
    """
    pool = await get_pool()
    
    # Insert or increment mention count
    query = """
        INSERT INTO document_entity_mentions (document_id, entity_id, mention_count)
        VALUES ($1, $2, 1)
        ON CONFLICT (document_id, entity_id) DO UPDATE
        SET mention_count = document_entity_mentions.mention_count + 1
    """
    
    async with pool.acquire() as conn:
        await conn.execute(query, document_id, entity_id)
        
        # Update global mention count on entity
        update_count_query = """
            UPDATE entities
            SET mention_count = (
                SELECT COUNT(DISTINCT document_id)
                FROM document_entity_mentions
                WHERE entity_id = $1
            )
            WHERE id = $1
        """
        await conn.execute(update_count_query, entity_id)


async def add_entity_relationship(
    source_name: str, target_name: str, rel_type: str, description: str = ""
) -> None:
    """Create a relationship between two entities.
    
    Args:
        source_name: Source entity name
        target_name: Target entity name
        rel_type: Relationship type
        description: Relationship description
    """
    pool = await get_pool()
    
    # Get or create both entities first
    source_id = await upsert_entity(source_name, "", "")
    target_id = await upsert_entity(target_name, "", "")
    
    query = """
        INSERT INTO entity_relationships (source_id, target_id, relationship_type, description)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (source_id, target_id, relationship_type) DO UPDATE
        SET description = EXCLUDED.description
    """
    
    async with pool.acquire() as conn:
        await conn.execute(query, source_id, target_id, rel_type, description)


async def update_document_summary(document_id: str, summary: str) -> None:
    """Update document summary.
    
    Args:
        document_id: Document UUID
        summary: Document summary from tier3 extraction
    """
    pool = await get_pool()
    
    query = """
        UPDATE documents
        SET summary = $2
        WHERE id = $1
    """
    
    async with pool.acquire() as conn:
        await conn.execute(query, document_id, summary)


async def get_document_id_by_base_id(base_id: str) -> str | None:
    """Get document UUID from legacy base_id.
    
    Args:
        base_id: Legacy base ID
        
    Returns:
        Document UUID as string, or None if not found
    """
    pool = await get_pool()
    
    query = """
        SELECT id FROM documents
        WHERE base_id = $1
    """
    
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, base_id)
        return str(row["id"]) if row else None
