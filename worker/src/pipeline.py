"""Complete enrichment pipeline for processing tasks."""

import asyncio
import logging

from qdrant_client import QdrantClient

from src import graph
from src.adapters import get_adapter
from src.config import QDRANT_URL
from src.schemas import get_schema_for_doctype
from src.tier2 import detect_language, process_text_nlp

logger = logging.getLogger(__name__)

# Initialize clients
qdrant = QdrantClient(url=QDRANT_URL)
adapter = get_adapter()


async def process_task(task: dict) -> None:
    """Process a single enrichment task through the full pipeline.

    Args:
        task: Task dictionary from Redis queue
    """
    base_id = task["baseId"]
    collection = task["collection"]
    doc_type = task["docType"]
    text = task["text"]
    chunk_index = task["chunkIndex"]
    total_chunks = task["totalChunks"]
    qdrant_id = task["qdrantId"]
    source = task.get("source", "")

    logger.info(f"Processing task for {base_id}:{chunk_index}/{total_chunks}")

    try:
        # Update status to processing
        await update_enrichment_status(qdrant_id, collection, "processing")

        # Tier 2: NLP extraction (per-chunk)
        tier2_data = await run_tier2_extraction(text)

        # Update Qdrant with tier-2 results
        await update_payload(qdrant_id, collection, {"tier2": tier2_data})

        # Tier 3: LLM extraction (document-level - only on last chunk)
        if chunk_index == total_chunks - 1:
            await run_document_level_extraction(base_id, collection, doc_type, total_chunks, source)

        # Mark chunk as enriched
        await update_enrichment_status(qdrant_id, collection, "enriched")

        logger.info(f"Successfully processed {base_id}:{chunk_index}")

    except Exception as e:
        logger.error(f"Error processing task {qdrant_id}: {e}", exc_info=True)
        await update_enrichment_status(qdrant_id, collection, "failed")
        raise


async def run_tier2_extraction(text: str) -> dict:
    """Run tier-2 NLP extraction on text.

    Args:
        text: Text to analyze

    Returns:
        Dictionary with tier-2 extracted data
    """
    tier2 = {}

    try:
        # Run CPU-bound NLP extractions in thread pool to avoid blocking event loop
        # Use optimized single-pass NLP for entities + keywords
        nlp_task = asyncio.to_thread(process_text_nlp, text)
        language_task = asyncio.to_thread(detect_language, text)

        nlp_result, language_result = await asyncio.gather(
            nlp_task,
            language_task,
            return_exceptions=True,
        )

        # Handle NLP result (entities + keywords)
        if isinstance(nlp_result, Exception):
            logger.warning(f"Tier-2 NLP extraction failed: {nlp_result}")
            tier2["entities"] = []
            tier2["keywords"] = []
        else:
            tier2["entities"] = nlp_result.get("entities", [])
            tier2["keywords"] = nlp_result.get("keywords", [])

        # Handle language detection result
        if isinstance(language_result, Exception):
            logger.warning(f"Tier-2 language detection failed: {language_result}")
            tier2["language"] = "unknown"
        else:
            tier2["language"] = language_result

        logger.debug(
            f"Tier-2 extraction: {len(tier2['entities'])} entities, "
            f"{len(tier2['keywords'])} keywords, lang={tier2['language']}"
        )

    except Exception as e:
        # Fallback in case of unexpected errors outside individual tasks
        logger.warning(f"Tier-2 extraction failed: {e}")
        tier2 = {"entities": [], "keywords": [], "language": "unknown"}

    return tier2


async def run_document_level_extraction(
    base_id: str, collection: str, doc_type: str, total_chunks: int, source: str
) -> None:
    """Run tier-3 LLM extraction on the full document.

    Args:
        base_id: Document base ID
        collection: Qdrant collection
        doc_type: Document type
        total_chunks: Number of chunks
        source: Document source
    """
    logger.info(f"Running document-level extraction for {base_id}")

    try:
        # Aggregate all chunks
        full_text = await aggregate_chunks(base_id, collection, total_chunks)

        # Type-specific metadata extraction
        schema_cls, prompt_template = get_schema_for_doctype(doc_type)
        schema_dict = schema_cls.model_json_schema()

        tier3_meta = await adapter.extract_metadata(
            full_text, doc_type, schema_dict, prompt_template
        )

        # Entity + relationship extraction
        entity_result = await adapter.extract_entities(full_text)

        # Update all chunks with tier-3 results
        update_tasks = []
        for i in range(total_chunks):
            chunk_id = f"{base_id}:{i}"
            update_tasks.append(update_payload(chunk_id, collection, {"tier3": tier3_meta}))

        # Use return_exceptions to handle partial failures gracefully
        update_results = await asyncio.gather(*update_tasks, return_exceptions=True)
        for idx, result in enumerate(update_results):
            if isinstance(result, Exception):
                logger.error(
                    f"Tier-3 payload update failed for chunk {base_id}:{idx}: {result}",
                    exc_info=True,
                )

        # Write to Neo4j
        await write_to_neo4j(base_id, doc_type, source, collection, tier3_meta, entity_result)

        logger.info(f"Completed document-level extraction for {base_id}")

    except Exception as e:
        logger.error(f"Document-level extraction failed for {base_id}: {e}", exc_info=True)
        raise


async def write_to_neo4j(
    base_id: str,
    doc_type: str,
    source: str,
    collection: str,
    tier3_meta: dict,
    entity_result: dict,
) -> None:
    """Write document, entities, and relationships to Neo4j.

    Args:
        base_id: Document ID
        doc_type: Document type
        source: Document source
        collection: Collection name
        tier3_meta: Tier-3 metadata
        entity_result: Entity extraction result
    """
    try:
        # Create document node
        summary = tier3_meta.get("summary", "")
        await graph.upsert_document(base_id, doc_type, source, collection, summary)

        # Create entity nodes and mentions
        entities = entity_result.get("entities", [])
        for entity in entities:
            entity_name = entity.get("name", "")
            entity_type = entity.get("type", "")
            entity_desc = entity.get("description", "")

            if entity_name:
                await graph.upsert_entity(entity_name, entity_type, entity_desc)
                await graph.add_mention(base_id, entity_name)

        # Create relationships between entities
        relationships = entity_result.get("relationships", [])
        for rel in relationships:
            source_entity = rel.get("source", "")
            target_entity = rel.get("target", "")
            rel_type = rel.get("type", "")
            rel_desc = rel.get("description", "")

            if source_entity and target_entity:
                await graph.add_relationship(source_entity, target_entity, rel_type, rel_desc)

        logger.info(f"Wrote to Neo4j: {len(entities)} entities, {len(relationships)} relationships")

    except Exception as e:
        logger.warning(f"Failed to write to Neo4j for {base_id}: {e}")
        # Don't raise - graph write is best-effort


async def aggregate_chunks(base_id: str, collection: str, total_chunks: int) -> str:
    """Aggregate text from all chunks of a document.

    Args:
        base_id: Document base ID
        collection: Qdrant collection
        total_chunks: Number of chunks

    Returns:
        Concatenated text from all chunks
    """
    # Build list of all chunk IDs and retrieve in a single call to avoid N+1
    chunk_ids = [f"{base_id}:{i}" for i in range(total_chunks)]

    try:
        # Run synchronous Qdrant call in thread pool to avoid blocking event loop
        points = await asyncio.to_thread(qdrant.retrieve, collection_name=collection, ids=chunk_ids)
    except Exception as e:
        logger.warning(f"Failed to retrieve chunks for {base_id}: {e}")
        return ""

    # Map point IDs to their text payloads
    id_to_text = {}
    for point in points or []:
        payload = getattr(point, "payload", None) or {}
        text = payload.get("text", "")
        point_id = getattr(point, "id", None)
        if text and point_id:
            id_to_text[point_id] = text

    # Preserve original ordering by chunk index
    texts = []
    for i in range(total_chunks):
        chunk_id = f"{base_id}:{i}"
        text = id_to_text.get(chunk_id)
        if text:
            texts.append(text)

    return "\n\n".join(texts)


async def update_enrichment_status(point_id: str, collection: str, status: str) -> None:
    """Update the enrichment status of a point in Qdrant.

    Args:
        point_id: Point ID
        collection: Collection name
        status: New status (pending, processing, enriched, failed)
    """
    try:
        # Run synchronous Qdrant call in thread pool to avoid blocking event loop
        await asyncio.to_thread(
            qdrant.set_payload,
            collection_name=collection,
            payload={"enrichmentStatus": status},
            points=[point_id],
        )
    except Exception as e:
        logger.error(f"Failed to update enrichment status for {point_id}: {e}")


async def update_payload(point_id: str, collection: str, payload: dict) -> None:
    """Update the payload of a point in Qdrant.

    Args:
        point_id: Point ID
        collection: Collection name
        payload: Payload data to merge
    """
    try:
        # Run synchronous Qdrant call in thread pool to avoid blocking event loop
        await asyncio.to_thread(
            qdrant.set_payload,
            collection_name=collection,
            payload=payload,
            points=[point_id],
        )
    except Exception as e:
        logger.error(f"Failed to update payload for {point_id}: {e}")
