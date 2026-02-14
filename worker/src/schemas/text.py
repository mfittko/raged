"""Generic text document metadata extraction schema."""
from pydantic import BaseModel
from typing import List


class TextMetadata(BaseModel):
    """Metadata extracted from generic text documents."""
    summary: str
    key_entities: List[str] = []


# Prompt template for text metadata extraction
PROMPT = """Analyze this text and extract metadata.

Provide:
- summary: A concise summary of the text
- key_entities: List of key entities, names, or concepts mentioned

Text:
{text}

Respond with valid JSON matching this schema: {schema}"""
