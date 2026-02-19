"""Image metadata extraction schema."""

from pydantic import BaseModel, Field


class ImageMetadata(BaseModel):
    """Metadata extracted from images."""

    summary_short: str = ""
    summary_medium: str = ""
    summary_long: str = ""
    summary: str = ""
    keywords: list[str] = Field(default_factory=list)
    description: str
    detected_objects: list[str] = Field(default_factory=list)
    ocr_text: str = ""
    image_type: str  # photo, diagram, screenshot, chart


# Prompt template for image metadata extraction
PROMPT = """Describe this image in detail.

Provide:
- summary_short: A one-sentence summary of the image content
- summary_medium: A 2-3 sentence summary of the image content
- summary_long: A detailed paragraph summary of the image content
- summary: Same content as summary_medium for backward compatibility
- keywords: List of important keywords from visual and OCR content
- description: A detailed description of the image
- detected_objects: List of main objects/entities visible in the image
- ocr_text: Any readable text visible in the image
- image_type: Classification (photo, diagram, screenshot, or chart)

{context}

Respond with valid JSON matching this schema: {schema}"""
