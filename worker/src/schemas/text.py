"""Generic text document metadata extraction schema."""

from pydantic import BaseModel, Field


class TextMetadata(BaseModel):
    """Metadata extracted from generic text documents."""

    summary_short: str = ""
    summary_medium: str = ""
    summary_long: str = ""
    summary: str = ""
    keywords: list[str] = Field(default_factory=list)
    key_entities: list[str] = Field(default_factory=list)


# Prompt template for text metadata extraction
PROMPT = """Analyze this text and extract metadata.

Provide:
- summary_short: A one-sentence summary of the text
- summary_medium: A 2-3 sentence summary of the text
- summary_long: A detailed paragraph summary of the text
- summary: Same content as summary_medium for backward compatibility
- keywords: List of important keywords for quick search/display
- key_entities: List of key entities, names, or concepts mentioned

Text:
{text}

Respond with valid JSON matching this schema: {schema}"""
