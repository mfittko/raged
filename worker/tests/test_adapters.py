"""Tests for LLM adapters."""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from src.adapters.base import ImageDescription
from src.adapters.ollama import OllamaAdapter
from src.adapters import get_adapter


@pytest.mark.asyncio
async def test_ollama_adapter_extract_metadata():
    """Test Ollama adapter metadata extraction."""
    adapter = OllamaAdapter()
    
    # Mock the httpx client
    with patch("httpx.AsyncClient") as mock_client:
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "response": '{"summary": "Test summary", "complexity": "low"}'
        }
        mock_response.raise_for_status = MagicMock()
        
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        
        schema = {
            "type": "object",
            "properties": {
                "summary": {"type": "string"},
                "complexity": {"type": "string"}
            }
        }
        
        result = await adapter.extract_metadata("test code", "code", schema)
        
        assert "summary" in result
        assert "complexity" in result


@pytest.mark.asyncio
async def test_ollama_adapter_extract_entities():
    """Test Ollama adapter entity extraction."""
    adapter = OllamaAdapter()
    
    with patch("httpx.AsyncClient") as mock_client:
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "response": '{"entities": [{"name": "TestClass", "type": "class", "description": "A test class"}], "relationships": []}'
        }
        mock_response.raise_for_status = MagicMock()
        
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        
        result = await adapter.extract_entities("test text")
        
        assert "entities" in result
        assert "relationships" in result
        assert isinstance(result["entities"], list)


@pytest.mark.asyncio
async def test_ollama_adapter_is_available():
    """Test Ollama availability check."""
    adapter = OllamaAdapter()
    
    with patch("httpx.AsyncClient") as mock_client:
        mock_response = MagicMock()
        mock_response.status_code = 200
        
        mock_client.return_value.__aenter__.return_value.get = AsyncMock(return_value=mock_response)
        
        result = await adapter.is_available()
        
        assert result is True


@pytest.mark.asyncio
async def test_ollama_adapter_is_not_available():
    """Test Ollama availability check when service is down."""
    adapter = OllamaAdapter()
    
    with patch("httpx.AsyncClient") as mock_client:
        mock_client.return_value.__aenter__.return_value.get = AsyncMock(side_effect=Exception("Connection error"))
        
        result = await adapter.is_available()
        
        assert result is False


@pytest.mark.asyncio
async def test_ollama_adapter_describe_image():
    """Test Ollama image description."""
    adapter = OllamaAdapter()
    
    with patch("httpx.AsyncClient") as mock_client:
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "response": '{"description": "A test image", "detected_objects": ["object1"], "ocr_text": "", "image_type": "photo"}'
        }
        mock_response.raise_for_status = MagicMock()
        
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        
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
    """Test Ollama adapter handles invalid JSON gracefully."""
    adapter = OllamaAdapter()
    
    with patch("httpx.AsyncClient") as mock_client:
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "response": 'invalid json{{{' 
        }
        mock_response.raise_for_status = MagicMock()
        
        mock_client.return_value.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        
        schema = {
            "type": "object",
            "properties": {
                "summary": {"type": "string"}
            }
        }
        
        result = await adapter.extract_metadata("test", "code", schema)
        
        # Should return empty structure rather than crashing
        assert isinstance(result, dict)
        assert "summary" in result
