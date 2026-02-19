"""Tests for LLM adapters."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.adapters import get_adapter
from src.adapters.base import ImageDescription
from src.adapters.openai import OpenAIAdapter
from src.adapters.ollama import OllamaAdapter, _normalize_ollama_base_url


def _mock_completion_response(content: str) -> SimpleNamespace:
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
    )


@pytest.mark.asyncio
async def test_ollama_adapter_extract_metadata():
    """Test Ollama adapter metadata extraction."""
    with patch("openai.AsyncOpenAI") as mock_openai:
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(
            return_value=_mock_completion_response(
                '{"summary": "Test summary", "complexity": "low"}'
            )
        )
        mock_openai.return_value = mock_client

        adapter = OllamaAdapter()
        schema = {
            "type": "object",
            "properties": {
                "summary": {"type": "string"},
                "complexity": {"type": "string"},
            },
        }

        result = await adapter.extract_metadata("test code", "code", schema)

        assert result["summary"] == "Test summary"
        assert result["complexity"] == "low"


@pytest.mark.asyncio
async def test_ollama_adapter_extract_entities():
    """Test Ollama adapter entity extraction."""
    with patch("openai.AsyncOpenAI") as mock_openai:
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(
            return_value=_mock_completion_response(
                '{"entities": [{"name": "TestClass", "type": "class", '
                '"description": "A test class"}], "relationships": []}'
            )
        )
        mock_openai.return_value = mock_client

        adapter = OllamaAdapter()
        result = await adapter.extract_entities("test text")

        assert "entities" in result
        assert "relationships" in result
        assert result["entities"][0]["name"] == "TestClass"


@pytest.mark.asyncio
async def test_ollama_adapter_is_available():
    """Test Ollama availability check."""
    with patch("openai.AsyncOpenAI") as mock_openai:
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(
            return_value=_mock_completion_response("{}")
        )
        mock_openai.return_value = mock_client

        adapter = OllamaAdapter()
        result = await adapter.is_available()

        assert result is True


@pytest.mark.asyncio
async def test_ollama_adapter_is_not_available():
    """Test Ollama availability check when service is down."""
    with patch("openai.AsyncOpenAI") as mock_openai:
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(
            side_effect=RuntimeError("Connection error")
        )
        mock_openai.return_value = mock_client

        adapter = OllamaAdapter()
        result = await adapter.is_available()

        assert result is False


@pytest.mark.asyncio
async def test_ollama_adapter_describe_image():
    """Test Ollama image description."""
    with patch("openai.AsyncOpenAI") as mock_openai:
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(
            return_value=_mock_completion_response(
                '{"description": "A test image", "detected_objects": ["object1"], '
                '"ocr_text": "", "image_type": "photo"}'
            )
        )
        mock_openai.return_value = mock_client

        adapter = OllamaAdapter()
        result = await adapter.describe_image("base64imagedata", "test context")

        assert isinstance(result, ImageDescription)
        assert result.description == "A test image"
        assert "object1" in result.detected_objects


def test_get_adapter_default():
    """Test adapter factory returns Ollama by default."""
    with patch("src.adapters.EXTRACTOR_PROVIDER", "ollama"):
        adapter = get_adapter()
        assert isinstance(adapter, OllamaAdapter)


def test_get_adapter_ollama():
    """Test adapter factory returns Ollama when configured."""
    with patch("src.adapters.EXTRACTOR_PROVIDER", "ollama"):
        adapter = get_adapter()
        assert isinstance(adapter, OllamaAdapter)


@pytest.mark.asyncio
async def test_ollama_adapter_handles_invalid_json():
    """Test adapter handles invalid JSON gracefully."""
    with patch("openai.AsyncOpenAI") as mock_openai:
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(
            return_value=_mock_completion_response("invalid json{{{")
        )
        mock_openai.return_value = mock_client

        adapter = OllamaAdapter()
        schema = {"type": "object", "properties": {"summary": {"type": "string"}}}
        result = await adapter.extract_metadata("test", "code", schema)

        assert isinstance(result, dict)
        assert result["summary"] == ""


@pytest.mark.asyncio
async def test_ollama_adapter_with_custom_prompt():
    """Test adapter uses custom prompt template when provided."""
    with patch("openai.AsyncOpenAI") as mock_openai:
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(
            return_value=_mock_completion_response(
                '{"summary": "Custom prompt result", "topics": ["AI", "ML"]}'
            )
        )
        mock_openai.return_value = mock_client

        adapter = OllamaAdapter()
        schema = {
            "type": "object",
            "properties": {"summary": {"type": "string"}, "topics": {"type": "array"}},
        }

        custom_prompt = "Analyze this article and extract: {fields}"
        result = await adapter.extract_metadata("article text", "article", schema, custom_prompt)

        assert mock_client.chat.completions.create.called
        request_kwargs = mock_client.chat.completions.create.call_args.kwargs
        assert "Analyze this article" in request_kwargs["messages"][1]["content"]
        assert result["summary"] == "Custom prompt result"


@pytest.mark.asyncio
async def test_openai_adapter_falls_back_when_json_mode_unsupported():
    """OpenAI-compatible adapter retries without JSON mode when unsupported."""
    with patch("openai.AsyncOpenAI") as mock_openai:
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(
            side_effect=[
                RuntimeError("response_format not supported"),
                _mock_completion_response("```json\n{\"summary\":\"Recovered\"}\n```"),
            ]
        )
        mock_openai.return_value = mock_client

        adapter = OpenAIAdapter(base_url="http://localhost:11434/v1", api_key="test")
        schema = {"type": "object", "properties": {"summary": {"type": "string"}}}

        result = await adapter.extract_metadata("test", "text", schema)

        assert result["summary"] == "Recovered"
        assert mock_client.chat.completions.create.await_count == 2


def test_ollama_adapter_normalizes_base_url():
    """Ollama base URL is always OpenAI-compatible (/v1)."""
    assert _normalize_ollama_base_url("http://localhost:11434") == "http://localhost:11434/v1"
    assert _normalize_ollama_base_url("http://localhost:11434/") == "http://localhost:11434/v1"
    assert _normalize_ollama_base_url("http://localhost:11434/v1") == "http://localhost:11434/v1"


def test_ollama_adapter_prefers_explicit_ollama_api_key():
    """Ollama adapter prefers OLLAMA_API_KEY over OPENAI_API_KEY."""
    with patch("src.adapters.ollama.OLLAMA_API_KEY", "ollama-token"):
        with patch("src.adapters.ollama.OPENAI_API_KEY", "openai-token"):
            with patch("openai.AsyncOpenAI") as mock_openai:
                OllamaAdapter()
                assert mock_openai.call_args.kwargs["api_key"] == "ollama-token"
