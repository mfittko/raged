"""Complete enrichment pipeline for processing tasks."""

import asyncio
import logging

from src import api_client
from src.adapters import get_adapter
from src.schemas import get_schema_for_doctype
from src.tier2 import detect_language, process_text_nlp

logger = logging.getLogger(__name__)

# Initialize adapter
adapter = get_adapter()


async def process_task(task: dict) -> None:
    """Process a single enrichment task through the full pipeline.

    Args:
        task: Task dictionary from API
    """
    base_id = task["baseId"]
    doc_type = task["docType"]
    text = task["text"]
    chunk_index = task["chunkIndex"]
    total_chunks = task["totalChunks"]
    source = task.get("source", "")
    collection = task.get("collection", "default")
    task_id = task["taskId"]

    logger.info(f"Processing task for {base_id}:{chunk_index}/{total_chunks}")

    try:
        # Tier 2: NLP extraction (per-chunk)
        tier2_data = await run_tier2_extraction(text)

        # Tier 3: LLM extraction (document-level - only on last chunk)
        tier3_data = None
        entities = None
        relationships = None
        summary = None

        if chunk_index == total_chunks - 1:
            tier3_result = await run_document_level_extraction(
                base_id, doc_type, text, total_chunks, source
            )
            tier3_data = tier3_result.get("tier3")
            entities = tier3_result.get("entities")
            relationships = tier3_result.get("relationships")
            summary = tier3_result.get("summary")

        # Submit all results in a single HTTP call
        chunk_id = f"{base_id}:{chunk_index}"
        await api_client.submit_result(
            task_id=task_id,
            chunk_id=chunk_id,
            collection=collection,
            tier2=tier2_data,
            tier3=tier3_data,
            entities=entities,
            relationships=relationships,
            summary=summary,
        )

        logger.info(f"Successfully processed {base_id}:{chunk_index}")

    except Exception as e:
        logger.error(f"Error processing task {base_id}:{chunk_index}: {e}", exc_info=True)
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
    base_id: str, doc_type: str, last_chunk_text: str, total_chunks: int, source: str
) -> dict:
    """Run tier-3 LLM extraction on the full document.

    Note: We only have access to the last chunk's text at this point.
    For multi-chunk documents, this is a limitation of the current architecture.
    Future enhancement: API could return all chunk texts in claim response.

    Args:
        base_id: Legacy base ID
        doc_type: Document type
        last_chunk_text: Text from the last chunk
        total_chunks: Number of chunks
        source: Document source

    Returns:
        Dictionary with tier3, entities, relationships, and summary
    """
    logger.info(f"Running document-level extraction for {base_id}")

    try:
        # For now, use the last chunk text for document-level extraction
        # TODO: API should return all chunk texts in the claim response
        full_text = last_chunk_text

        # Type-specific metadata extraction
        schema_cls, prompt_template = get_schema_for_doctype(doc_type)
        schema_dict = schema_cls.model_json_schema()

        tier3_meta = await adapter.extract_metadata(
            full_text, doc_type, schema_dict, prompt_template
        )

        # Entity + relationship extraction
        entity_result = await adapter.extract_entities(full_text)

        # Extract summary
        summary = tier3_meta.get("summary", "")

        # Format entities for API
        entities = []
        for entity in entity_result.get("entities", []):
            entity_name = entity.get("name", "")
            entity_type = entity.get("type", "")
            entity_desc = entity.get("description", "")

            if entity_name:
                entities.append({
                    "name": entity_name,
                    "type": entity_type,
                    "description": entity_desc,
                })

        # Format relationships for API
        relationships = []
        for rel in entity_result.get("relationships", []):
            source_entity = rel.get("source", "")
            target_entity = rel.get("target", "")
            rel_type = rel.get("type", "")
            rel_desc = rel.get("description", "")

            if source_entity and target_entity:
                relationships.append({
                    "source": source_entity,
                    "target": target_entity,
                    "type": rel_type,
                    "description": rel_desc,
                })

        logger.info(
            f"Completed document-level extraction for {base_id}: "
            f"{len(entities)} entities, {len(relationships)} relationships"
        )

        return {
            "tier3": tier3_meta,
            "entities": entities,
            "relationships": relationships,
            "summary": summary,
        }

    except Exception as e:
        logger.error(f"Document-level extraction failed for {base_id}: {e}", exc_info=True)
        raise
