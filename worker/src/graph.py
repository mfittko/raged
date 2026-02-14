"""Neo4j graph client for entity and relationship storage."""
import logging
from typing import Dict, List, Optional
from neo4j import AsyncGraphDatabase, AsyncDriver
from src.config import NEO4J_URL, NEO4J_USER, NEO4J_PASSWORD

logger = logging.getLogger(__name__)

# Global driver instance
_driver: Optional[AsyncDriver] = None


def get_driver() -> AsyncDriver:
    """Get or create the Neo4j driver instance."""
    global _driver
    if _driver is None:
        if not NEO4J_URL or not NEO4J_USER:
            raise ValueError("NEO4J_URL and NEO4J_USER must be configured")
        
        _driver = AsyncGraphDatabase.driver(
            NEO4J_URL,
            auth=(NEO4J_USER, NEO4J_PASSWORD) if NEO4J_PASSWORD else None
        )
    return _driver


async def close_driver():
    """Close the Neo4j driver."""
    global _driver
    if _driver:
        await _driver.close()
        _driver = None


async def upsert_entity(name: str, entity_type: str, description: str = "") -> None:
    """Create or update an entity node in Neo4j.
    
    Args:
        name: Entity name
        entity_type: Entity type (person, class, concept, etc.)
        description: Entity description
    """
    driver = get_driver()
    async with driver.session() as session:
        await session.run("""
            MERGE (e:Entity {name: $name})
            SET e.type = $type,
                e.description = $description,
                e.lastSeen = datetime(),
                e.mentionCount = coalesce(e.mentionCount, 0) + 1
            ON CREATE SET e.firstSeen = datetime()
        """, name=name, type=entity_type, description=description)


async def upsert_document(
    doc_id: str,
    doc_type: str,
    source: str,
    collection: str,
    summary: str = ""
) -> None:
    """Create or update a document node in Neo4j.
    
    Args:
        doc_id: Document ID (same as Qdrant base ID)
        doc_type: Document type (code, slack, email, etc.)
        source: Document source path or URL
        collection: Qdrant collection name
        summary: Document summary
    """
    driver = get_driver()
    async with driver.session() as session:
        await session.run("""
            MERGE (d:Document {id: $id})
            SET d.docType = $docType,
                d.source = $source,
                d.collection = $collection,
                d.summary = $summary,
                d.ingestedAt = datetime()
        """, id=doc_id, docType=doc_type, source=source, collection=collection, summary=summary)


async def add_mention(doc_id: str, entity_name: str) -> None:
    """Create a MENTIONS relationship between a document and an entity.
    
    Args:
        doc_id: Document ID
        entity_name: Entity name
    """
    driver = get_driver()
    async with driver.session() as session:
        await session.run("""
            MATCH (d:Document {id: $docId})
            MATCH (e:Entity {name: $entityName})
            MERGE (d)-[:MENTIONS]->(e)
        """, docId=doc_id, entityName=entity_name)


async def add_relationship(
    source: str,
    target: str,
    rel_type: str,
    description: str = ""
) -> None:
    """Create a RELATES_TO relationship between two entities.
    
    Args:
        source: Source entity name
        target: Target entity name
        rel_type: Relationship type (uses, depends-on, etc.)
        description: Relationship description
    """
    driver = get_driver()
    async with driver.session() as session:
        await session.run("""
            MERGE (s:Entity {name: $source})
            MERGE (t:Entity {name: $target})
            MERGE (s)-[r:RELATES_TO]->(t)
            SET r.type = $type,
                r.description = $description
        """, source=source, target=target, type=rel_type, description=description)


async def get_entity_neighborhood(name: str, depth: int = 2) -> Dict:
    """Get an entity and its neighborhood within specified depth.
    
    Args:
        name: Entity name
        depth: How many hops to traverse (default: 2)
        
    Returns:
        Dictionary with entity info, connections, and related documents
    """
    driver = get_driver()
    async with driver.session() as session:
        result = await session.run("""
            MATCH (e:Entity {name: $name})
            OPTIONAL MATCH path = (e)-[r:RELATES_TO*1..$depth]-(connected:Entity)
            OPTIONAL MATCH (d:Document)-[:MENTIONS]->(e)
            RETURN e,
                   collect(DISTINCT connected) as connections,
                   collect(DISTINCT d) as documents
        """, name=name, depth=depth)
        
        record = await result.single()
        if not record:
            return {
                "entity": None,
                "connections": [],
                "documents": []
            }
        
        entity = record["e"]
        connections = record["connections"]
        documents = record["documents"]
        
        return {
            "entity": {
                "name": entity.get("name"),
                "type": entity.get("type"),
                "description": entity.get("description"),
                "mentionCount": entity.get("mentionCount", 0)
            } if entity else None,
            "connections": [
                {
                    "name": c.get("name"),
                    "type": c.get("type")
                } for c in connections if c
            ],
            "documents": [
                {
                    "id": d.get("id"),
                    "docType": d.get("docType"),
                    "source": d.get("source")
                } for d in documents if d
            ]
        }


async def get_entity(name: str) -> Optional[Dict]:
    """Get a single entity by name.
    
    Args:
        name: Entity name
        
    Returns:
        Entity dict or None if not found
    """
    driver = get_driver()
    async with driver.session() as session:
        result = await session.run("""
            MATCH (e:Entity {name: $name})
            RETURN e
        """, name=name)
        
        record = await result.single()
        if not record:
            return None
        
        entity = record["e"]
        return {
            "name": entity.get("name"),
            "type": entity.get("type"),
            "description": entity.get("description"),
            "mentionCount": entity.get("mentionCount", 0),
            "firstSeen": str(entity.get("firstSeen")) if entity.get("firstSeen") else None,
            "lastSeen": str(entity.get("lastSeen")) if entity.get("lastSeen") else None
        }


async def search_entities(query: str, limit: int = 10) -> List[Dict]:
    """Search for entities by name (case-insensitive partial match).
    
    Args:
        query: Search query
        limit: Maximum number of results
        
    Returns:
        List of matching entities
    """
    driver = get_driver()
    async with driver.session() as session:
        result = await session.run("""
            MATCH (e:Entity)
            WHERE toLower(e.name) CONTAINS toLower($query)
            RETURN e
            ORDER BY e.mentionCount DESC
            LIMIT $limit
        """, query=query, limit=limit)
        
        entities = []
        async for record in result:
            entity = record["e"]
            entities.append({
                "name": entity.get("name"),
                "type": entity.get("type"),
                "description": entity.get("description"),
                "mentionCount": entity.get("mentionCount", 0)
            })
        
        return entities
