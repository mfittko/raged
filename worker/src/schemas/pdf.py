"""PDF document metadata extraction schema."""

from pydantic import BaseModel


class Section(BaseModel):
    """A section from a PDF document."""

    title: str
    summary: str


class PDFMetadata(BaseModel):
    """Metadata extracted from PDF documents."""

    summary: str
    key_entities: list[str] = []
    sections: list[Section] = []


# Prompt template for PDF metadata extraction
PROMPT = """Analyze this PDF document and extract metadata.

Provide:
- summary: An overall summary of the document
- key_entities: List of key entities, names, or concepts mentioned
- sections: List of major sections with title and summary

PDF content:
{text}

Respond with valid JSON matching this schema: {schema}"""
