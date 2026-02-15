"""Complete enrichment pipeline for processing tasks."""

import asyncio
import logging

from src import db
from src.adapters import get_adapter
from src.schemas import get_schema_for_doctype
from src.tier2 import detect_language, process_text_nlp

logger = logging.getLogger(__name__)

# Initialize adapter
adapter = get_adapter()


async def process_task(task: dict) -> None:
    """Process a single enrichment task through the full pipeline.

    Args:
        task: Task dictionary from database queue
    """
    base_id = task["baseId"]
    doc_type = task["docType"]
    text = task["text"]
    chunk_index = task["chunkIndex"]
    total_chunks = task["totalChunks"]
    source = task.get("source", "")

    logger.info(f"Processing task for {base_id}:{chunk_index}/{total_chunks}")

    # Get document UUID from legacy base_id
    document_id = await db.get_document_id_by_base_id(base_id)
    if not document_id:
        logger.error(f"Document not found for base_id: {base_id}")
        raise ValueError(f"Document not found: {base_id}")

    try:
        # Update status to processing
        await db.update_chunk_status(base_id, document_id, chunk_index, "processing")

        # Tier 2: NLP extraction (per-chunk)
        tier2_data = await run_tier2_extraction(text)

        # Update chunk with tier-2 results
        await db.update_chunk_tier2(document_id, chunk_index, tier2_data)

        # Tier 3: LLM extraction (document-level - only on last chunk)
        if chunk_index == total_chunks - 1:
            await run_document_level_extraction(
                document_id, base_id, doc_type, total_chunks, source
            )

        # Mark chunk as enriched (tier3 update does this, but tier2-only chunks need it)
        if chunk_index != total_chunks - 1:
            await db.update_chunk_status(base_id, document_id, chunk_index, "enriched")

        logger.info(f"Successfully processed {base_id}:{chunk_index}")

    except Exception as e:
        logger.error(f"Error processing task {base_id}:{chunk_index}: {e}", exc_info=True)
        await db.update_chunk_status(base_id, document_id, chunk_index, "failed")
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
    document_id: str, base_id: str, doc_type: str, total_chunks: int, source: str
) -> None:
    """Run tier-3 LLM extraction on the full document.

    Args:
        document_id: Document UUID
        base_id: Legacy base ID
        doc_type: Document type
        total_chunks: Number of chunks
        source: Document source
    """
    logger.info(f"Running document-level extraction for {base_id}")

    try:
        # Aggregate all chunks
        full_text = await aggregate_chunks(document_id, total_chunks)

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
            update_tasks.append(db.update_chunk_tier3(document_id, i, tier3_meta))

        # Use return_exceptions to handle partial failures gracefully
        update_results = await asyncio.gather(*update_tasks, return_exceptions=True)
        for idx, result in enumerate(update_results):
            if isinstance(result, Exception):
                logger.error(
                    f"Tier-3 payload update failed for chunk {base_id}:{idx}: {result}",
                    exc_info=True,
                )

        # Write entities and relationships to Postgres
        await write_entities_to_db(document_id, base_id, tier3_meta, entity_result)

        logger.info(f"Completed document-level extraction for {base_id}")

    except Exception as e:
        logger.error(f"Document-level extraction failed for {base_id}: {e}", exc_info=True)
        raise


async def write_entities_to_db(
    document_id: str,
    base_id: str,
    tier3_meta: dict,
    entity_result: dict,
) -> None:
    """Write document summary, entities, and relationships to Postgres.

    Args:
        document_id: Document UUID
        base_id: Legacy base ID
        tier3_meta: Tier-3 metadata
        entity_result: Entity extraction result
    """
    try:
        # Update document summary
        summary = tier3_meta.get("summary", "")
        if summary:
            await db.update_document_summary(document_id, summary)

        # Create entity nodes and mentions
        entities = entity_result.get("entities", [])
        for entity in entities:
            entity_name = entity.get("name", "")
            entity_type = entity.get("type", "")
            entity_desc = entity.get("description", "")

            if entity_name:
                entity_id = await db.upsert_entity(entity_name, entity_type, entity_desc)
                await db.add_document_mention(document_id, entity_id)

        # Create relationships between entities
        relationships = entity_result.get("relationships", [])
        for rel in relationships:
            source_entity = rel.get("source", "")
            target_entity = rel.get("target", "")
            rel_type = rel.get("type", "")
            rel_desc = rel.get("description", "")

            if source_entity and target_entity:
                await db.add_entity_relationship(source_entity, target_entity, rel_type, rel_desc)

        logger.info(f"Wrote to DB: {len(entities)} entities, {len(relationships)} relationships")

    except Exception as e:
        logger.warning(f"Failed to write entities for {base_id}: {e}")
        # Don't raise - entity write is best-effort


async def aggregate_chunks(document_id: str, total_chunks: int) -> str:
    """Aggregate text from all chunks of a document.

    Args:
        document_id: Document UUID
        total_chunks: Number of chunks

    Returns:
        Concatenated text from all chunks
    """
    try:
        texts = await db.get_chunks_text(document_id, total_chunks)
    except Exception as e:
        logger.warning(f"Failed to retrieve chunks for document {document_id}: {e}")
        return ""

    # Filter out empty chunks and join
    return "\n\n".join(text for text in texts if text)

