"""OpenAI adapter for LLM extraction."""
import json
import logging
from typing import Dict
from src.adapters.base import ExtractorAdapter, ImageDescription
from src.config import OPENAI_API_KEY, EXTRACTOR_MODEL_FAST, EXTRACTOR_MODEL_CAPABLE

logger = logging.getLogger(__name__)


class OpenAIAdapter(ExtractorAdapter):
    """OpenAI GPT-based LLM extraction adapter."""
    
    def __init__(self):
        if not OPENAI_API_KEY:
            raise ValueError("OPENAI_API_KEY environment variable is required")
        
        from openai import AsyncOpenAI
        self.client = AsyncOpenAI(api_key=OPENAI_API_KEY)
        self.fast_model = EXTRACTOR_MODEL_FAST
        self.capable_model = EXTRACTOR_MODEL_CAPABLE
        self.max_tokens = 4096
    
    async def extract_metadata(self, text: str, doc_type: str, schema: Dict, prompt_template: str = "") -> Dict:
        """Extract type-specific metadata using GPT."""
        # Use custom prompt template if provided, otherwise use generic prompt
        if prompt_template:
            prompt = prompt_template.replace("{text}", text[:8000]).replace("{schema}", json.dumps(schema, indent=2))
        else:
            prompt = f"""Analyze this {doc_type} document and extract metadata according to the schema.

Text:
{text[:8000]}

Schema:
{json.dumps(schema, indent=2)}

Extract the metadata as JSON."""
        
        return await self._extract_structured(prompt, schema, self.fast_model)
    
    async def extract_entities(self, text: str) -> Dict:
        """Extract entities and relationships using GPT."""
        prompt = f"""Extract entities and relationships from this text.

Text:
{text[:8000]}

For each entity, provide:
- name: entity name
- type: entity type (person, class, concept, project, org, etc.)
- description: brief description

For each relationship:
- source: source entity name
- target: target entity name
- type: relationship type (uses, depends-on, discusses, implements, etc.)
- description: brief description"""
        
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
                            "description": {"type": "string"}
                        },
                        "required": ["name", "type", "description"]
                    }
                },
                "relationships": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "source": {"type": "string"},
                            "target": {"type": "string"},
                            "type": {"type": "string"},
                            "description": {"type": "string"}
                        },
                        "required": ["source", "target", "type"]
                    }
                }
            },
            "required": ["entities", "relationships"]
        }
        
        return await self._extract_structured(prompt, schema, self.capable_model)
    
    async def describe_image(self, image_base64: str, context: str = "") -> ImageDescription:
        """Describe an image using GPT-4 Vision."""
        prompt = f"""Describe this image in detail. Provide:
- description: A detailed description of the image
- detected_objects: List of main objects/entities visible
- ocr_text: Any text visible in the image
- image_type: Classification (photo, diagram, screenshot, chart)

{f'Context: {context}' if context else ''}

Respond in JSON format."""
        
        schema = {
            "type": "object",
            "properties": {
                "description": {"type": "string"},
                "detected_objects": {"type": "array", "items": {"type": "string"}},
                "ocr_text": {"type": "string"},
                "image_type": {"type": "string"}
            },
            "required": ["description", "detected_objects", "ocr_text", "image_type"]
        }
        
        try:
            response = await self.client.chat.completions.create(
                model=self.capable_model,
                messages=[{
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": prompt
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{image_base64}"
                            }
                        }
                    ]
                }],
                max_tokens=self.max_tokens,
                response_format={"type": "json_object"}
            )
            
            result = json.loads(response.choices[0].message.content)
            return ImageDescription(**result)
            
        except Exception as e:
            logger.error(f"Error in image description: {e}")
            return ImageDescription(description="", detected_objects=[], ocr_text="", image_type="")
    
    async def is_available(self) -> bool:
        """Check if OpenAI API is available."""
        try:
            # Try a minimal API call
            await self.client.chat.completions.create(
                model=self.fast_model,
                messages=[{"role": "user", "content": "test"}],
                max_tokens=5
            )
            return True
        except Exception as e:
            logger.warning(f"OpenAI availability check failed: {e}")
            return False
    
    async def _extract_structured(self, prompt: str, schema: Dict, model: str) -> Dict:
        """Extract structured data using OpenAI's JSON mode."""
        try:
            response = await self.client.chat.completions.create(
                model=model,
                messages=[{
                    "role": "system",
                    "content": "You are a helpful assistant that extracts structured data. Always respond with valid JSON."
                }, {
                    "role": "user",
                    "content": prompt
                }],
                max_tokens=self.max_tokens,
                response_format={"type": "json_object"}
            )
            
            result = json.loads(response.choices[0].message.content)
            return result
            
        except Exception as e:
            logger.error(f"Error in structured extraction: {e}")
            return self._empty_response_for_schema(schema)
    
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
