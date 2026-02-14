"""Complete enrichment pipeline for processing tasks."""
import json
import logging
from typing import Dict, List
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct
from src.config import QDRANT_URL, MAX_RETRIES
from src.tier2 import extract_entities as nlp_entities, extract_keywords, detect_language
from src.adapters import get_adapter
from src.schemas import get_schema_for_doctype
from src import graph

logger = logging.getLogger(__name__)

# Initialize clients
qdrant = QdrantClient(url=QDRANT_URL)
adapter = get_adapter()


async def process_task(task: Dict) -> None:
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
        update_enrichment_status(qdrant_id, collection, "processing")
        
        # Tier 2: NLP extraction (per-chunk)
        tier2_data = await run_tier2_extraction(text)
        
        # Update Qdrant with tier-2 results
        update_payload(qdrant_id, collection, {"tier2": tier2_data})
        
        # Tier 3: LLM extraction (document-level - only on last chunk)
        if chunk_index == total_chunks - 1:
            await run_document_level_extraction(
                base_id, collection, doc_type, total_chunks, source
            )
        
        # Mark chunk as enriched
        update_enrichment_status(qdrant_id, collection, "enriched")
        
        logger.info(f"Successfully processed {base_id}:{chunk_index}")
        
    except Exception as e:
        logger.error(f"Error processing task {qdrant_id}: {e}", exc_info=True)
        update_enrichment_status(qdrant_id, collection, "failed")
        raise


async def run_tier2_extraction(text: str) -> Dict:
    """Run tier-2 NLP extraction on text.
    
    Args:
        text: Text to analyze
        
    Returns:
        Dictionary with tier-2 extracted data
    """
    tier2 = {}
    
    try:
        # Entity extraction
        entities = nlp_entities(text)
        tier2["entities"] = entities
        
        # Keyword extraction
        keywords = extract_keywords(text)
        tier2["keywords"] = keywords
        
        # Language detection
        language = detect_language(text)
        tier2["language"] = language
        
        logger.debug(f"Tier-2 extraction: {len(entities)} entities, {len(keywords)} keywords, lang={language}")
        
    except Exception as e:
        logger.warning(f"Tier-2 extraction failed: {e}")
        tier2 = {"entities": [], "keywords": [], "language": "unknown"}
    
    return tier2


async def run_document_level_extraction(
    base_id: str,
    collection: str,
    doc_type: str,
    total_chunks: int,
    source: str
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
        full_text = aggregate_chunks(base_id, collection, total_chunks)
        
        # Type-specific metadata extraction
        schema_cls, prompt_template = get_schema_for_doctype(doc_type)
        schema_dict = schema_cls.model_json_schema()
        
        tier3_meta = await adapter.extract_metadata(full_text, doc_type, schema_dict)
        
        # Entity + relationship extraction
        entity_result = await adapter.extract_entities(full_text)
        
        # Update all chunks with tier-3 results
        for i in range(total_chunks):
            chunk_id = f"{base_id}:{i}"
            update_payload(chunk_id, collection, {"tier3": tier3_meta})
        
        # Write to Neo4j
        await write_to_neo4j(
            base_id,
            doc_type,
            source,
            collection,
            tier3_meta,
            entity_result
        )
        
        logger.info(f"Completed document-level extraction for {base_id}")
        
    except Exception as e:
        logger.error(f"Document-level extraction failed for {base_id}: {e}", exc_info=True)
        raise


async def write_to_neo4j(
    base_id: str,
    doc_type: str,
    source: str,
    collection: str,
    tier3_meta: Dict,
    entity_result: Dict
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


def aggregate_chunks(base_id: str, collection: str, total_chunks: int) -> str:
    """Aggregate text from all chunks of a document.
    
    Args:
        base_id: Document base ID
        collection: Qdrant collection
        total_chunks: Number of chunks
        
    Returns:
        Concatenated text from all chunks
    """
    texts = []
    
    for i in range(total_chunks):
        chunk_id = f"{base_id}:{i}"
        try:
            points = qdrant.retrieve(
                collection_name=collection,
                ids=[chunk_id]
            )
            if points:
                payload = points[0].payload
                text = payload.get("text", "")
                texts.append(text)
        except Exception as e:
            logger.warning(f"Failed to retrieve chunk {chunk_id}: {e}")
    
    return "\n\n".join(texts)


def update_enrichment_status(point_id: str, collection: str, status: str) -> None:
    """Update the enrichment status of a point in Qdrant.
    
    Args:
        point_id: Point ID
        collection: Collection name
        status: New status (pending, processing, enriched, failed)
    """
    try:
        qdrant.set_payload(
            collection_name=collection,
            payload={"enrichmentStatus": status},
            points=[point_id]
        )
    except Exception as e:
        logger.error(f"Failed to update enrichment status for {point_id}: {e}")


def update_payload(point_id: str, collection: str, payload: Dict) -> None:
    """Update the payload of a point in Qdrant.
    
    Args:
        point_id: Point ID
        collection: Collection name
        payload: Payload data to merge
    """
    try:
        qdrant.set_payload(
            collection_name=collection,
            payload=payload,
            points=[point_id]
        )
    except Exception as e:
        logger.error(f"Failed to update payload for {point_id}: {e}")


def get_source_from_qdrant(base_id: str, collection: str) -> str:
    """Get the source field from the first chunk of a document.
    
    Args:
        base_id: Document base ID
        collection: Collection name
        
    Returns:
        Source string
    """
    try:
        points = qdrant.retrieve(
            collection_name=collection,
            ids=[f"{base_id}:0"]
        )
        if points:
            return points[0].payload.get("source", "")
    except Exception as e:
        logger.warning(f"Failed to get source for {base_id}: {e}")
    
    return ""
