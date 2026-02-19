"""Ollama adapter implemented via OpenAI-compatible chat completions."""

from src.adapters.openai import OpenAIAdapter
from src.config import OLLAMA_API_KEY, OLLAMA_URL, OPENAI_API_KEY


def _normalize_ollama_base_url(url: str) -> str:
    """Return an OpenAI-compatible Ollama base URL ending with /v1."""
    stripped = url.rstrip("/")
    if stripped.endswith("/v1"):
        return stripped
    return f"{stripped}/v1"


class OllamaAdapter(OpenAIAdapter):
    """Ollama extraction adapter using OpenAI-compatible API."""

    def __init__(self):
        api_key = OLLAMA_API_KEY or OPENAI_API_KEY or "not-required"
        super().__init__(base_url=_normalize_ollama_base_url(OLLAMA_URL), api_key=api_key)
