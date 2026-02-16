"""Tests for the enrichment pipeline."""

from unittest.mock import AsyncMock, patch

import pytest

from src.pipeline import (
    process_task,
    run_document_level_extraction,
    run_tier2_extraction,
)

# Check if spaCy model is available
try:
    import spacy

    spacy.load("en_core_web_sm")
    SPACY_AVAILABLE = True
except Exception:
    SPACY_AVAILABLE = False


@pytest.fixture
def mock_task():
    """Create a mock task."""
    return {
        "taskId": "task-123",
        "qdrantId": "repo:file.py:0",
        "collection": "docs",
        "docType": "code",
        "baseId": "repo:file.py",
        "chunkIndex": 0,
        "totalChunks": 1,
        "text": "def hello():\n    print('Hello')",
        "source": "repo/file.py",
        "attempt": 1,
    }


@pytest.mark.asyncio
@pytest.mark.skipif(not SPACY_AVAILABLE, reason="spaCy model en_core_web_sm not installed")
async def test_run_tier2_extraction():
    """Test tier-2 extraction."""
    text = "Apple Inc. was founded by Steve Jobs in Cupertino."

    result = await run_tier2_extraction(text)

    assert "entities" in result
    assert "keywords" in result
    assert "language" in result
    assert isinstance(result["entities"], list)
    assert isinstance(result["keywords"], list)
    assert result["language"] == "en"


@pytest.mark.asyncio
async def test_run_tier2_extraction_empty_text():
    """Test tier-2 extraction with empty text."""
    result = await run_tier2_extraction("")

    assert result["entities"] == []
    assert result["keywords"] == []


@pytest.mark.asyncio
async def test_process_task_single_chunk(mock_task):
    """Test processing a single-chunk task."""
    with (
        patch("src.pipeline.api_client") as mock_api_client,
        patch("src.pipeline.adapter") as mock_adapter,
    ):
        # Mock API client operations
        mock_api_client.submit_result = AsyncMock()

        # Mock adapter responses
        mock_adapter.extract_metadata = AsyncMock(
            return_value={
                "summary": "Test function",
                "purpose": "Greeting",
                "complexity": "low",
            }
        )
        mock_adapter.extract_entities = AsyncMock(
            return_value={"entities": [], "relationships": []}
        )

        # Process the task
        await process_task(mock_task)

        # Verify API submit was called
        assert mock_api_client.submit_result.called
        call_args = mock_api_client.submit_result.call_args
        assert call_args[1]["task_id"] == "task-123"
        assert call_args[1]["chunk_id"] == "repo:file.py:0"
        assert call_args[1]["collection"] == "docs"


@pytest.mark.asyncio
async def test_process_task_multi_chunk_middle(mock_task):
    """Test processing a middle chunk of a multi-chunk document."""
    mock_task["chunkIndex"] = 1
    mock_task["totalChunks"] = 3
    mock_task["qdrantId"] = "repo:file.py:1"

    with (
        patch("src.pipeline.api_client") as mock_api_client,
        patch("src.pipeline.adapter") as mock_adapter,
    ):
        # Mock API client operations
        mock_api_client.submit_result = AsyncMock()

        # Process the task (middle chunk - no tier3)
        await process_task(mock_task)

        # Verify API submit was called with only tier2
        call_args = mock_api_client.submit_result.call_args
        assert call_args[1]["tier2"] is not None
        assert call_args[1]["tier3"] is None
        assert call_args[1]["entities"] is None
        assert call_args[1]["relationships"] is None
        assert call_args[1]["summary"] is None


@pytest.mark.asyncio
async def test_process_task_multi_chunk_last(mock_task):
    """Test processing the last chunk of a multi-chunk document."""
    mock_task["chunkIndex"] = 2
    mock_task["totalChunks"] = 3
    mock_task["qdrantId"] = "repo:file.py:2"

    with (
        patch("src.pipeline.api_client") as mock_api_client,
        patch("src.pipeline.adapter") as mock_adapter,
    ):
        # Mock API client operations
        mock_api_client.submit_result = AsyncMock()

        # Mock adapter responses
        mock_adapter.extract_metadata = AsyncMock(return_value={"summary": "Test function"})
        mock_adapter.extract_entities = AsyncMock(
            return_value={"entities": [], "relationships": []}
        )

        # Process the task
        await process_task(mock_task)

        # Verify document-level extraction was triggered
        assert mock_adapter.extract_metadata.called

        # Verify API submit was called with tier2 and tier3
        call_args = mock_api_client.submit_result.call_args
        assert call_args[1]["tier2"] is not None
        assert call_args[1]["tier3"] is not None


@pytest.mark.asyncio
async def test_process_task_handles_error(mock_task):
    """Test that process_task handles errors gracefully."""
    with patch("src.pipeline.api_client") as mock_api_client:
        # Make API client raise an error during submit
        mock_api_client.submit_result = AsyncMock(side_effect=RuntimeError("Test error"))

        # Should raise the exception
        with pytest.raises(RuntimeError, match="Test error"):
            await process_task(mock_task)


@pytest.mark.asyncio
async def test_run_document_level_extraction():
    """Test document-level extraction."""
    with patch("src.pipeline.adapter") as mock_adapter:
        # Mock adapter responses
        mock_adapter.extract_metadata = AsyncMock(return_value={"summary": "Test"})
        mock_adapter.extract_entities = AsyncMock(
            return_value={
                "entities": [{"name": "TestEntity", "type": "class", "description": "Test"}],
                "relationships": [{"source": "A", "target": "B", "type": "uses", "description": ""}],
            }
        )

        # Run extraction
        result = await run_document_level_extraction(
            "base-id", "code", "test text", 1, "test.py"
        )

        # Verify result structure
        assert "tier3" in result
        assert "entities" in result
        assert "relationships" in result
        assert "summary" in result
        assert len(result["entities"]) == 1
        assert len(result["relationships"]) == 1
        assert result["entities"][0]["name"] == "TestEntity"
        assert result["relationships"][0]["source"] == "A"
        assert result["relationships"][0]["target"] == "B"
        assert result["relationships"][0]["type"] == "uses"
