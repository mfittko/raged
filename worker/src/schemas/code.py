"""Code document metadata extraction schema."""
from pydantic import BaseModel


class CodeMetadata(BaseModel):
    """Metadata extracted from code documents."""
    summary: str
    purpose: str
    complexity: str  # low, medium, high


# Prompt template for code metadata extraction
PROMPT = """Analyze this code and extract metadata.

Provide:
- summary: A 1-2 sentence summary of what this code does
- purpose: The purpose of this code in the broader system
- complexity: Rate the complexity as "low", "medium", or "high"

Code:
{text}

Respond with valid JSON matching this schema: {schema}"""
