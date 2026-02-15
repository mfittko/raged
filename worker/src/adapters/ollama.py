"""Ollama adapter for LLM extraction."""

import json
import logging

import httpx

from src.adapters.base import ExtractorAdapter, ImageDescription
from src.config import (
    EXTRACTOR_MODEL_CAPABLE,
    EXTRACTOR_MODEL_FAST,
    EXTRACTOR_MODEL_VISION,
    OLLAMA_URL,
)

logger = logging.getLogger(__name__)


class OllamaAdapter(ExtractorAdapter):
    """Ollama-based LLM extraction adapter."""

    def __init__(self):
        self.base_url = OLLAMA_URL
        self.fast_model = EXTRACTOR_MODEL_FAST
        self.capable_model = EXTRACTOR_MODEL_CAPABLE
        self.vision_model = EXTRACTOR_MODEL_VISION
        self.timeout = 60.0

    async def extract_metadata(
        self, text: str, doc_type: str, schema: dict, prompt_template: str = ""
    ) -> dict:
        """Extract type-specific metadata using Ollama."""
        # Use custom prompt template if provided, otherwise use generic prompt
        if prompt_template:
            prompt = prompt_template.replace("{text}", text[:8000]).replace(
                "{schema}", json.dumps(schema, indent=2)
            )
        else:
            # Truncate to 8000 chars (Ollama typically has larger context)
            prompt = (
                f"Analyze this {doc_type} document and extract metadata "
                f"according to the schema.\n\n"
                f"Text:\n{text[:8000]}\n\n"
                f"Schema:\n{json.dumps(schema, indent=2)}\n\n"
                f"Respond with valid JSON matching the schema. "
                f"Do not include any explanation, just the JSON."
            )

        return await self._generate_structured(prompt, schema, self.fast_model)

    async def extract_entities(self, text: str) -> dict:
        """Extract entities and relationships using Ollama."""
        # Truncate to 8000 chars to match other adapters
        prompt = f"""Extract entities and relationships from this text.

Text:
{text[:8000]}

For each entity, provide:
- name: entity name
- type: entity type (person, class, concept, project, org, etc.)
- description: brief description

For each relationship, provide:
- source: source entity name
- target: target entity name
- type: relationship type (uses, depends-on, discusses, implements, etc.)
- description: brief description of the relationship

Respond with valid JSON in this format:
{{
  "entities": [
    {{"name": "...", "type": "...", "description": "..."}}
  ],
  "relationships": [
    {{"source": "...", "target": "...", "type": "...", "description": "..."}}
  ]
}}"""

        schema = {
            "type": "object",
            "properties": {
                "entities": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "type": {"type": "string"},
                            "description": {"type": "string"},
                        },
                        "required": ["name", "type"],
                    },
                },
                "relationships": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "source": {"type": "string"},
                            "target": {"type": "string"},
                            "type": {"type": "string"},
                            "description": {"type": "string"},
                        },
                        "required": ["source", "target", "type"],
                    },
                },
            },
        }

        return await self._generate_structured(prompt, schema, self.capable_model)

    async def describe_image(self, image_base64: str, context: str = "") -> ImageDescription:
        """Describe an image using Ollama's vision model."""
        prompt = f"""Describe this image in detail. Provide:
- description: A detailed description of the image
- detected_objects: List of main objects/entities visible
- ocr_text: Any text visible in the image
- image_type: Classification (photo, diagram, screenshot, chart)

{f"Context: {context}" if context else ""}

Respond with valid JSON in this format:
{{
  "description": "...",
  "detected_objects": ["...", "..."],
  "ocr_text": "...",
  "image_type": "..."
}}"""

        schema = {
            "type": "object",
            "properties": {
                "description": {"type": "string"},
                "detected_objects": {"type": "array", "items": {"type": "string"}},
                "ocr_text": {"type": "string"},
                "image_type": {"type": "string"},
            },
            "required": ["description"],
        }

        result = await self._generate_vision(prompt, image_base64, schema)
        return ImageDescription(**result)

    async def is_available(self) -> bool:
        """Check if Ollama is reachable."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self.base_url}/api/tags")
                return response.status_code == 200
        except Exception as e:
            logger.warning(f"Ollama availability check failed: {e}")
            return False

    async def _generate_structured(
        self, prompt: str, schema: dict, model: str, max_retries: int = 3
    ) -> dict:
        """Generate structured output from Ollama with retry logic."""
        for attempt in range(max_retries):
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    response = await client.post(
                        f"{self.base_url}/api/generate",
                        json={
                            "model": model,
                            "prompt": prompt,
                            "stream": False,
                            "format": "json",
                        },
                    )
                    response.raise_for_status()
                    result = response.json()

                    # Parse the response
                    generated_text = result.get("response", "")
                    parsed = json.loads(generated_text)

                    # Basic validation - check if it has expected structure
                    if isinstance(parsed, dict):
                        return parsed

            except json.JSONDecodeError as e:
                logger.warning(f"JSON decode error on attempt {attempt + 1}: {e}")
                if attempt == max_retries - 1:
                    # Last attempt - return empty structure
                    return self._empty_response_for_schema(schema)
            except Exception as e:
                logger.error(f"Error generating structured output on attempt {attempt + 1}: {e}")
                if attempt == max_retries - 1:
                    return self._empty_response_for_schema(schema)

        return self._empty_response_for_schema(schema)

    async def _generate_vision(self, prompt: str, image_base64: str, schema: dict) -> dict:
        """Generate vision output from Ollama."""
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    f"{self.base_url}/api/generate",
                    json={
                        "model": self.vision_model,
                        "prompt": prompt,
                        "images": [image_base64],
                        "stream": False,
                        "format": "json",
                    },
                )
                response.raise_for_status()
                result = response.json()

                # Parse the response
                generated_text = result.get("response", "")
                parsed = json.loads(generated_text)

                if isinstance(parsed, dict):
                    return parsed

        except Exception as e:
            logger.error(f"Error in vision generation: {e}")

        return self._empty_response_for_schema(schema)

    def _empty_response_for_schema(self, schema: dict) -> dict:
        """Generate an empty response matching the schema structure."""
        result = {}
        if "properties" in schema:
            for key, prop in schema["properties"].items():
                if prop.get("type") == "array":
                    result[key] = []
                elif prop.get("type") == "string":
                    result[key] = ""
                elif prop.get("type") == "object":
                    result[key] = {}
        return result
