"""Entity and relationship extraction schema."""
from pydantic import BaseModel
from typing import List


class Entity(BaseModel):
    """An entity extracted from text."""
    name: str
    type: str  # person, class, concept, project, org, etc.
    description: str = ""


class Relationship(BaseModel):
    """A relationship between two entities."""
    source: str  # entity name
    target: str  # entity name
    type: str    # uses, depends-on, discusses, implements, etc.
    description: str = ""


class EntityExtractionResult(BaseModel):
    """Result of entity and relationship extraction."""
    entities: List[Entity] = []
    relationships: List[Relationship] = []


# Prompt template for entity extraction
PROMPT = """Extract entities and relationships from the following text.

For each entity, identify:
- name: The entity name (person, organization, class, concept, etc.)
- type: The type of entity (person, class, concept, project, org, etc.)
- description: A brief description of the entity

For each relationship between entities, identify:
- source: The source entity name
- target: The target entity name
- type: The relationship type (uses, depends-on, discusses, implements, inherits, etc.)
- description: A brief description of the relationship

Text:
{text}

Respond with valid JSON matching this schema: {schema}"""
