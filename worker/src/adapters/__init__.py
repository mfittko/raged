"""Adapter factory and exports."""
from src.adapters.base import ExtractorAdapter, ImageDescription
from src.config import EXTRACTOR_PROVIDER


def get_adapter() -> ExtractorAdapter:
    """Get the configured LLM adapter.
    
    Returns:
        ExtractorAdapter instance based on EXTRACTOR_PROVIDER config
    """
    if EXTRACTOR_PROVIDER == "anthropic":
        from src.adapters.anthropic import AnthropicAdapter
        return AnthropicAdapter()
    elif EXTRACTOR_PROVIDER == "openai":
        from src.adapters.openai import OpenAIAdapter
        return OpenAIAdapter()
    else:
        # Default to Ollama
        from src.adapters.ollama import OllamaAdapter
        return OllamaAdapter()


__all__ = ["ExtractorAdapter", "ImageDescription", "get_adapter"]
