"""Image metadata extraction schema."""

from pydantic import BaseModel


class ImageMetadata(BaseModel):
    """Metadata extracted from images."""

    description: str
    detected_objects: list[str] = []
    ocr_text: str = ""
    image_type: str  # photo, diagram, screenshot, chart


# Prompt template for image metadata extraction
PROMPT = """Describe this image in detail.

Provide:
- description: A detailed description of the image
- detected_objects: List of main objects/entities visible in the image
- ocr_text: Any readable text visible in the image
- image_type: Classification (photo, diagram, screenshot, or chart)

{context}

Respond with valid JSON matching this schema: {schema}"""
