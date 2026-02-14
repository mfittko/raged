"""Base adapter interface for LLM extraction."""
from abc import ABC, abstractmethod
from typing import Dict, List
from pydantic import BaseModel


class ImageDescription(BaseModel):
    """Result of image description extraction."""
    description: str
    detected_objects: List[str] = []
    ocr_text: str = ""
    image_type: str = ""  # photo, diagram, screenshot, chart


class ExtractorAdapter(ABC):
    """Abstract base class for LLM extraction adapters."""
    
    @abstractmethod
    async def extract_metadata(self, text: str, doc_type: str, schema: Dict, prompt_template: str = "") -> Dict:
        """Extract type-specific metadata using the fast model.
        
        Args:
            text: Text to analyze
            doc_type: Document type (code, slack, email, etc.)
            schema: JSON schema for the expected output
            prompt_template: Optional prompt template from schema module
            
        Returns:
            Extracted metadata as a dictionary
        """
        pass
    
    @abstractmethod
    async def extract_entities(self, text: str) -> Dict:
        """Extract entities and relationships using the capable model.
        
        Args:
            text: Text to analyze
            
        Returns:
            Dictionary with 'entities' and 'relationships' lists
        """
        pass
    
    @abstractmethod
    async def describe_image(self, image_base64: str, context: str = "") -> ImageDescription:
        """Describe an image using the vision model.
        
        Args:
            image_base64: Base64-encoded image data
            context: Optional context about the image
            
        Returns:
            ImageDescription object
        """
        pass
    
    @abstractmethod
    async def is_available(self) -> bool:
        """Check if the provider is reachable.
        
        Returns:
            True if available, False otherwise
        """
        pass
