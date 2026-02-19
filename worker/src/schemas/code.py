"""Code document metadata extraction schema."""

from pydantic import BaseModel, Field


class CodeMetadata(BaseModel):
    """Metadata extracted from code documents."""

    summary_short: str = ""
    summary_medium: str = ""
    summary_long: str = ""
    summary: str = ""
    keywords: list[str] = Field(default_factory=list)
    purpose: str
    complexity: str  # low, medium, high


# Prompt template for code metadata extraction
PROMPT = """Analyze this code and extract metadata.

Provide:
- summary_short: A one-sentence summary of what this code does
- summary_medium: A 2-3 sentence summary of what this code does
- summary_long: A detailed paragraph summary of what this code does
- summary: Same content as summary_medium for backward compatibility
- keywords: List of important keywords (APIs, modules, patterns)
- purpose: The purpose of this code in the broader system
- complexity: Rate the complexity as "low", "medium", or "high"

Code:
{text}

Respond with valid JSON matching this schema: {schema}"""
