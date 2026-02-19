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


def _ensure_invoice_date_in_summary(summary: str, invoice_date: str) -> str:
    """Ensure invoice summaries include invoice date when available."""
    normalized_summary = str(summary).strip()
    normalized_date = str(invoice_date).strip()

    if not normalized_summary or not normalized_date:
        return normalized_summary

    if normalized_date.lower() in normalized_summary.lower():
        return normalized_summary

    separator = " " if normalized_summary.endswith(('.', '!', '?')) else ". "
    return f"{normalized_summary}{separator}Invoice date: {normalized_date}."


def _ensure_invoice_identifier_in_summary(summary: str, invoice_identifier: str) -> str:
    """Ensure invoice summaries include invoice identifier when available."""
    normalized_summary = str(summary).strip()
    normalized_identifier = str(invoice_identifier).strip()

    if not normalized_summary or not normalized_identifier:
        return normalized_summary

    if normalized_identifier.lower() in normalized_summary.lower():
        return normalized_summary

    separator = " " if normalized_summary.endswith(('.', '!', '?')) else ". "
    return f"{normalized_summary}{separator}Invoice identifier: {normalized_identifier}."


def _normalize_tier3_metadata(tier3_meta: dict) -> dict:
    """Normalize tier-3 metadata to always include multi-level summaries and keywords."""
    summary_short = str(tier3_meta.get("summary_short") or "").strip()
    summary_medium = str(tier3_meta.get("summary_medium") or "").strip()
    summary_long = str(tier3_meta.get("summary_long") or "").strip()
    summary_legacy = str(tier3_meta.get("summary") or "").strip()

    if not summary_medium:
        summary_medium = summary_legacy or summary_short or summary_long
    if not summary_short:
        summary_short = summary_medium or summary_long
    if not summary_long:
        summary_long = summary_medium or summary_short

    invoice_value = tier3_meta.get("invoice")
    if isinstance(invoice_value, dict):
        is_invoice = bool(invoice_value.get("is_invoice"))
        invoice_date = str(invoice_value.get("invoice_date") or "").strip()
        invoice_identifier = str(invoice_value.get("invoice_identifier") or "").strip()
        invoice_number = str(invoice_value.get("invoice_number") or "").strip()

        if not invoice_identifier and invoice_number:
            invoice_identifier = invoice_number
            invoice_value["invoice_identifier"] = invoice_identifier
        if not invoice_number and invoice_identifier:
            invoice_value["invoice_number"] = invoice_identifier

        if is_invoice and invoice_date:
            summary_short = _ensure_invoice_date_in_summary(summary_short, invoice_date)
            summary_medium = _ensure_invoice_date_in_summary(summary_medium, invoice_date)
            summary_long = _ensure_invoice_date_in_summary(summary_long, invoice_date)
        if is_invoice and invoice_identifier:
            summary_short = _ensure_invoice_identifier_in_summary(summary_short, invoice_identifier)
            summary_medium = _ensure_invoice_identifier_in_summary(summary_medium, invoice_identifier)
            summary_long = _ensure_invoice_identifier_in_summary(summary_long, invoice_identifier)

    keywords_value = tier3_meta.get("keywords")
    if isinstance(keywords_value, list):
        keywords = [str(value).strip() for value in keywords_value if str(value).strip()]
    else:
        keywords = []

    if not keywords:
        key_entities = tier3_meta.get("key_entities")
        if isinstance(key_entities, list):
            keywords = [str(value).strip() for value in key_entities if str(value).strip()]

    tier3_meta["summary_short"] = summary_short
    tier3_meta["summary_medium"] = summary_medium
    tier3_meta["summary_long"] = summary_long
    tier3_meta["summary"] = summary_medium
    tier3_meta["keywords"] = keywords
    return tier3_meta


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
    all_chunks = task.get("allChunks")

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
                base_id, doc_type, text, total_chunks, source, all_chunks
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
    base_id: str,
    doc_type: str,
    last_chunk_text: str,
    total_chunks: int,
    source: str,
    all_chunks: list[str] | None = None,
) -> dict:
    """Run tier-3 LLM extraction on the full document.

    Args:
        base_id: Legacy base ID
        doc_type: Document type
        last_chunk_text: Text from the last chunk
        total_chunks: Number of chunks
        source: Document source
        all_chunks: Ordered list of all chunk texts for the document

    Returns:
        Dictionary with tier3, entities, relationships, and summary
    """
    logger.info(f"Running document-level extraction for {base_id}")

    full_text = last_chunk_text
    if all_chunks:
        full_text = "\n\n".join(all_chunks)
    elif total_chunks > 1:
        logger.warning(
            f"Document {base_id} has {total_chunks} chunks, but only last chunk text "
            f"is available for tier-3 extraction because allChunks is missing from task payload."
        )

    try:
        # Type-specific metadata extraction
        schema_cls, prompt_template = get_schema_for_doctype(doc_type)
        schema_dict = schema_cls.model_json_schema()

        tier3_meta = await adapter.extract_metadata(
            full_text, doc_type, schema_dict, prompt_template
        )
        tier3_meta = _normalize_tier3_metadata(tier3_meta)

        # Entity + relationship extraction
        entity_result = await adapter.extract_entities(full_text)

        # Extract summary
        summary = str(tier3_meta.get("summary_medium") or tier3_meta.get("summary") or "")

        # Format entities for API
        entities = []
        for entity in entity_result.get("entities", []):
            entity_name = entity.get("name", "")
            entity_type = entity.get("type", "")
            entity_desc = entity.get("description", "")

            if entity_name:
                entities.append(
                    {
                        "name": entity_name,
                        "type": entity_type,
                        "description": entity_desc,
                    }
                )

        # Format relationships for API
        relationships = []
        for rel in entity_result.get("relationships", []):
            source_entity = rel.get("source", "")
            target_entity = rel.get("target", "")
            rel_type = rel.get("type", "")
            rel_desc = rel.get("description", "")

            if source_entity and target_entity:
                relationships.append(
                    {
                        "source": source_entity,
                        "target": target_entity,
                        "type": rel_type,
                        "description": rel_desc,
                    }
                )

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
