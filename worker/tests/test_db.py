"""Tests for Postgres database operations."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.db import (
    add_document_mention,
    add_entity_relationship,
    complete_task,
    dequeue_task,
    fail_task,
    get_chunks_text,
    get_document_id_by_base_id,
    get_or_create_entity_id,
    recover_stale_leases,
    update_chunk_status,
    update_chunk_tier2,
    update_chunk_tier3,
    update_document_summary,
    update_entity_mention_counts,
    upsert_entity,
)


@pytest.fixture
def mock_pool():
    """Create a mock asyncpg pool."""
    pool = MagicMock()
    conn = MagicMock()

    # Setup async context manager
    conn.execute = AsyncMock()
    conn.fetchrow = AsyncMock()
    conn.fetch = AsyncMock()

    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock()

    return pool, conn


@pytest.mark.asyncio
async def test_dequeue_task_success(mock_pool):
    """Test successful task dequeue."""
    pool, conn = mock_pool

    mock_row = {
        "id": "task-uuid-123",
        "payload": {
            "qdrantId": "doc-1:0",
            "baseId": "doc-1",
            "chunkIndex": 0,
            "text": "test text",
        },
        "attempt": 1,
        "created_at": "2026-02-15T10:00:00",
    }
    conn.fetchrow.return_value = mock_row

    with patch("src.db.get_pool", return_value=pool):
        task = await dequeue_task("worker-1")

        assert task is not None
        assert task["taskId"] == "task-uuid-123"
        assert task["attempt"] == 1
        assert task["baseId"] == "doc-1"
        assert conn.fetchrow.called


@pytest.mark.asyncio
async def test_dequeue_task_no_tasks(mock_pool):
    """Test dequeue when no tasks available."""
    pool, conn = mock_pool
    conn.fetchrow.return_value = None

    with patch("src.db.get_pool", return_value=pool):
        task = await dequeue_task("worker-1")

        assert task is None


@pytest.mark.asyncio
async def test_complete_task(mock_pool):
    """Test marking task as completed."""
    pool, conn = mock_pool

    with patch("src.db.get_pool", return_value=pool):
        await complete_task("task-uuid-123")

        assert conn.execute.called
        call_args = conn.execute.call_args[0]
        assert "UPDATE task_queue" in call_args[0]
        assert "completed" in call_args[0]


@pytest.mark.asyncio
async def test_fail_task_retry(mock_pool):
    """Test task failure with retry."""
    pool, conn = mock_pool

    with patch("src.db.get_pool", return_value=pool):
        await fail_task("task-uuid-123", "Test error", attempt=1, max_attempts=3)

        assert conn.execute.called
        call_args = conn.execute.call_args[0]
        assert "pending" in call_args[0]
        assert call_args[2] == 2  # attempt incremented
        assert "$3 * interval '1 second'" in call_args[0]


@pytest.mark.asyncio
async def test_fail_task_dead(mock_pool):
    """Test task failure marking as dead."""
    pool, conn = mock_pool

    with patch("src.db.get_pool", return_value=pool):
        await fail_task("task-uuid-123", "Test error", attempt=3, max_attempts=3)

        assert conn.execute.called
        call_args = conn.execute.call_args[0]
        assert "dead" in call_args[0]


@pytest.mark.asyncio
async def test_recover_stale_leases(mock_pool):
    """Test stale lease recovery."""
    pool, conn = mock_pool
    conn.execute.return_value = "UPDATE 2"

    with patch("src.db.get_pool", return_value=pool):
        count = await recover_stale_leases()

        assert count == 2
        assert conn.execute.called


@pytest.mark.asyncio
async def test_update_chunk_status(mock_pool):
    """Test updating chunk enrichment status."""
    pool, conn = mock_pool

    with patch("src.db.get_pool", return_value=pool):
        await update_chunk_status("doc-uuid-1", 0, "enriched")

        assert conn.execute.called


@pytest.mark.asyncio
async def test_update_chunk_tier2(mock_pool):
    """Test updating tier2 metadata."""
    pool, conn = mock_pool

    tier2_data = {"entities": ["Entity1"], "keywords": ["key1"]}

    with patch("src.db.get_pool", return_value=pool):
        await update_chunk_tier2("doc-uuid-1", 0, tier2_data)

        assert conn.execute.called


@pytest.mark.asyncio
async def test_update_chunk_tier3(mock_pool):
    """Test updating tier3 metadata."""
    pool, conn = mock_pool

    tier3_data = {"summary": "Test summary"}

    with patch("src.db.get_pool", return_value=pool):
        await update_chunk_tier3("doc-uuid-1", 0, tier3_data)

        assert conn.execute.called
        call_args = conn.execute.call_args[0]
        assert "enriched" in call_args[0]


@pytest.mark.asyncio
async def test_get_chunks_text(mock_pool):
    """Test getting chunk texts."""
    pool, conn = mock_pool

    mock_rows = [
        {"chunk_index": 0, "text": "First chunk"},
        {"chunk_index": 1, "text": "Second chunk"},
    ]
    conn.fetch.return_value = mock_rows

    with patch("src.db.get_pool", return_value=pool):
        texts = await get_chunks_text("doc-uuid-1", 2)

        assert len(texts) == 2
        assert texts[0] == "First chunk"
        assert texts[1] == "Second chunk"


@pytest.mark.asyncio
async def test_upsert_entity(mock_pool):
    """Test entity upsert."""
    pool, conn = mock_pool
    conn.fetchrow.return_value = {"id": "entity-uuid-1"}

    with patch("src.db.get_pool", return_value=pool):
        entity_id = await upsert_entity("TestEntity", "class", "A test entity")

        assert entity_id == "entity-uuid-1"
        assert conn.fetchrow.called


@pytest.mark.asyncio
async def test_add_document_mention(mock_pool):
    """Test adding document mention."""
    pool, conn = mock_pool

    with patch("src.db.get_pool", return_value=pool):
        await add_document_mention("doc-uuid-1", "entity-uuid-1")

        # Should execute once: insert mention (no longer updates count)
        assert conn.execute.call_count == 1


@pytest.mark.asyncio
async def test_add_entity_relationship(mock_pool):
    """Test adding entity relationship."""
    pool, conn = mock_pool
    conn.fetchrow.return_value = {"id": "entity-uuid-1"}

    with patch("src.db.get_pool", return_value=pool):
        with patch("src.db.get_or_create_entity_id", return_value="entity-uuid-1"):
            await add_entity_relationship("EntityA", "EntityB", "uses", "EntityA uses EntityB")

            assert conn.execute.called


@pytest.mark.asyncio
async def test_get_or_create_entity_id(mock_pool):
    """Test get-or-create entity helper preserves existing metadata semantics."""
    pool, conn = mock_pool
    conn.fetchrow.return_value = {"id": "entity-uuid-1"}

    with patch("src.db.get_pool", return_value=pool):
        entity_id = await get_or_create_entity_id("TestEntity")

        assert entity_id == "entity-uuid-1"
        assert conn.fetchrow.called
        call_args = conn.fetchrow.call_args[0]
        assert "ON CONFLICT (name) DO UPDATE" in call_args[0]
        assert "SET last_seen = now()" in call_args[0]


@pytest.mark.asyncio
async def test_update_document_summary(mock_pool):
    """Test updating document summary."""
    pool, conn = mock_pool

    with patch("src.db.get_pool", return_value=pool):
        await update_document_summary("doc-uuid-1", "Test summary")

        assert conn.execute.called


@pytest.mark.asyncio
async def test_update_entity_mention_counts(mock_pool):
    """Test bulk updating entity mention counts."""
    pool, conn = mock_pool

    with patch("src.db.get_pool", return_value=pool):
        await update_entity_mention_counts(["entity-uuid-1", "entity-uuid-2"])

        assert conn.execute.called
        call_args = conn.execute.call_args[0]
        assert "UPDATE entities" in call_args[0]
        assert "WHERE id = ANY($1)" in call_args[0]


@pytest.mark.asyncio
async def test_update_entity_mention_counts_empty_list(mock_pool):
    """Test bulk update with empty list does nothing."""
    pool, conn = mock_pool

    with patch("src.db.get_pool", return_value=pool):
        await update_entity_mention_counts([])

        # Should not execute any queries
        assert not conn.execute.called


@pytest.mark.asyncio
async def test_get_document_id_by_base_id(mock_pool):
    """Test getting document UUID from base_id."""
    pool, conn = mock_pool
    conn.fetchrow.return_value = {"id": "doc-uuid-1"}

    with patch("src.db.get_pool", return_value=pool):
        doc_id = await get_document_id_by_base_id("doc-1")

        assert doc_id == "doc-uuid-1"


@pytest.mark.asyncio
async def test_get_document_id_by_base_id_not_found(mock_pool):
    """Test getting document UUID when not found."""
    pool, conn = mock_pool
    conn.fetchrow.return_value = None

    with patch("src.db.get_pool", return_value=pool):
        doc_id = await get_document_id_by_base_id("nonexistent")

        assert doc_id is None
