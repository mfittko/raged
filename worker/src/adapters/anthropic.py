"""Anthropic adapter for LLM extraction."""

import json
import logging
from typing import Dict
from src.adapters.base import ExtractorAdapter, ImageDescription
from src.config import ANTHROPIC_API_KEY, EXTRACTOR_MODEL_FAST, EXTRACTOR_MODEL_CAPABLE

logger = logging.getLogger(__name__)


class AnthropicAdapter(ExtractorAdapter):
    """Anthropic Claude-based LLM extraction adapter."""

    def __init__(self):
        if not ANTHROPIC_API_KEY:
            raise ValueError("ANTHROPIC_API_KEY environment variable is required")

        from anthropic import AsyncAnthropic

        self.client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
        self.fast_model = EXTRACTOR_MODEL_FAST
        self.capable_model = EXTRACTOR_MODEL_CAPABLE
        self.max_tokens = 4096

    async def extract_metadata(
        self, text: str, doc_type: str, schema: Dict, prompt_template: str = ""
    ) -> Dict:
        """Extract type-specific metadata using Claude."""
        # Use custom prompt template if provided, otherwise use generic prompt
        if prompt_template:
            prompt = prompt_template.replace("{text}", text[:8000]).replace(
                "{schema}", json.dumps(schema, indent=2)
            )
        else:
            prompt = f"""Analyze this {doc_type} document and extract metadata according to the provided schema.

Text:
{text[:8000]}

Extract the metadata and provide it as structured JSON."""

        return await self._extract_with_tools(
            prompt, schema, "metadata_extraction", self.fast_model
        )

    async def extract_entities(self, text: str) -> Dict:
        """Extract entities and relationships using Claude."""
        prompt = f"""Extract entities and relationships from this text.

Text:
{text[:8000]}

For each entity, identify:
- name: entity name
- type: entity type (person, class, concept, project, org, etc.)
- description: brief description

For each relationship between entities:
- source: source entity name
- target: target entity name
- type: relationship type (uses, depends-on, discusses, implements, etc.)
- description: brief description

Extract all entities and relationships you can identify."""

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
                        "required": ["name", "type", "description"],
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
            "required": ["entities", "relationships"],
        }

        return await self._extract_with_tools(
            prompt, schema, "entity_extraction", self.capable_model
        )

    async def describe_image(
        self, image_base64: str, context: str = ""
    ) -> ImageDescription:
        """Describe an image using Claude's vision capabilities."""
        prompt = f"""Describe this image in detail. Provide:
- description: A detailed description of the image
- detected_objects: List of main objects/entities visible in the image
- ocr_text: Any readable text visible in the image
- image_type: Classification (photo, diagram, screenshot, or chart)

{f"Context: {context}" if context else ""}"""

        try:
            message = await self.client.messages.create(
                model=self.capable_model,  # Vision requires capable model
                max_tokens=self.max_tokens,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/jpeg",
                                    "data": image_base64,
                                },
                            },
                            {"type": "text", "text": prompt},
                        ],
                    }
                ],
            )

            # Parse the response
            response_text = message.content[0].text

            # Try to extract structured data from response
            result = self._parse_image_description(response_text)
            return ImageDescription(**result)

        except Exception as e:
            logger.error(f"Error in image description: {e}")
            return ImageDescription(
                description="", detected_objects=[], ocr_text="", image_type=""
            )

    async def is_available(self) -> bool:
        """Check if Anthropic API is available."""
        try:
            # Try a minimal API call
            await self.client.messages.create(
                model=self.fast_model,
                max_tokens=10,
                messages=[{"role": "user", "content": "test"}],
            )
            return True
        except Exception as e:
            logger.warning(f"Anthropic availability check failed: {e}")
            return False

    async def _extract_with_tools(
        self, prompt: str, schema: Dict, tool_name: str, model: str
    ) -> Dict:
        """Extract structured data using Claude's tool use."""
        try:
            message = await self.client.messages.create(
                model=model,
                max_tokens=self.max_tokens,
                tools=[
                    {
                        "name": tool_name,
                        "description": f"Extract structured data for {tool_name}",
                        "input_schema": schema,
                    }
                ],
                messages=[{"role": "user", "content": prompt}],
            )

            # Extract tool use from response
            for content in message.content:
                if content.type == "tool_use":
                    return content.input

            # No tool use found, return empty
            logger.warning(f"No tool use in response for {tool_name}")
            return self._empty_response_for_schema(schema)

        except Exception as e:
            logger.error(f"Error in structured extraction: {e}")
            return self._empty_response_for_schema(schema)

    def _parse_image_description(self, text: str) -> Dict:
        """Parse image description from Claude's response text."""
        # Try to find JSON in the response
        try:
            # Look for JSON block
            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                json_str = text[start:end]
                return json.loads(json_str)
        except Exception:
            logger.debug(
                "Failed to parse image description as JSON; falling back to heuristic parsing",
                exc_info=True,
            )

        # Fallback: parse from structured text
        result = {
            "description": text,
            "detected_objects": [],
            "ocr_text": "",
            "image_type": "",
        }

        # Try to extract objects mentioned
        if "objects" in text.lower() or "visible" in text.lower():
            # Simple heuristic extraction
            lines = text.split("\n")
            for line in lines:
                if "object" in line.lower() or "visible" in line.lower():
                    # Extract words that might be objects
                    words = line.split()
                    result["detected_objects"].extend(
                        [w.strip(",.:-") for w in words if len(w) > 3]
                    )

        return result

    def _empty_response_for_schema(self, schema: Dict) -> Dict:
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
