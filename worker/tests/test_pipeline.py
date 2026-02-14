"""Tests for the enrichment pipeline."""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from src.pipeline import (
    process_task,
    run_tier2_extraction,
    run_document_level_extraction,
    aggregate_chunks,
    update_enrichment_status,
    update_payload
)


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
        "attempt": 1
    }


@pytest.mark.asyncio
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
    with patch("src.pipeline.qdrant") as mock_qdrant, \
         patch("src.pipeline.adapter") as mock_adapter, \
         patch("src.pipeline.graph") as mock_graph:
        
        # Mock adapter responses
        mock_adapter.extract_metadata = AsyncMock(return_value={
            "summary": "Test function",
            "purpose": "Greeting",
            "complexity": "low"
        })
        mock_adapter.extract_entities = AsyncMock(return_value={
            "entities": [],
            "relationships": []
        })
        
        # Mock graph operations
        mock_graph.upsert_document = AsyncMock()
        mock_graph.upsert_entity = AsyncMock()
        
        # Process the task
        await process_task(mock_task)
        
        # Verify status updates were called
        assert mock_qdrant.set_payload.called


@pytest.mark.asyncio
async def test_process_task_multi_chunk(mock_task):
    """Test processing the last chunk of a multi-chunk document."""
    mock_task["chunkIndex"] = 2
    mock_task["totalChunks"] = 3
    mock_task["qdrantId"] = "repo:file.py:2"
    
    with patch("src.pipeline.qdrant") as mock_qdrant, \
         patch("src.pipeline.adapter") as mock_adapter, \
         patch("src.pipeline.graph") as mock_graph:
        
        # Mock Qdrant retrieve for aggregation
        mock_points = [
            MagicMock(payload={"text": f"chunk {i}"})
            for i in range(3)
        ]
        mock_qdrant.retrieve.return_value = mock_points[:1]  # Return one at a time
        
        # Mock adapter responses
        mock_adapter.extract_metadata = AsyncMock(return_value={
            "summary": "Test function"
        })
        mock_adapter.extract_entities = AsyncMock(return_value={
            "entities": [],
            "relationships": []
        })
        
        # Mock graph operations
        mock_graph.upsert_document = AsyncMock()
        
        # Process the task
        await process_task(mock_task)
        
        # Verify document-level extraction was triggered
        assert mock_adapter.extract_metadata.called


def test_aggregate_chunks():
    """Test chunk aggregation."""
    with patch("src.pipeline.qdrant") as mock_qdrant:
        # Mock Qdrant points
        mock_qdrant.retrieve.return_value = [
            MagicMock(payload={"text": "chunk 0"}),
        ]
        
        result = aggregate_chunks("base-id", "docs", 2)
        
        # Should have made 2 retrieve calls
        assert mock_qdrant.retrieve.call_count == 2
        assert isinstance(result, str)


def test_update_enrichment_status():
    """Test updating enrichment status."""
    with patch("src.pipeline.qdrant") as mock_qdrant:
        update_enrichment_status("point-id", "docs", "enriched")
        
        # Verify set_payload was called
        assert mock_qdrant.set_payload.called
        call_args = mock_qdrant.set_payload.call_args
        assert call_args[1]["payload"]["enrichmentStatus"] == "enriched"


def test_update_payload():
    """Test updating point payload."""
    with patch("src.pipeline.qdrant") as mock_qdrant:
        payload = {"tier2": {"entities": [], "keywords": []}}
        update_payload("point-id", "docs", payload)
        
        # Verify set_payload was called
        assert mock_qdrant.set_payload.called


@pytest.mark.asyncio
async def test_process_task_handles_error(mock_task):
    """Test that process_task handles errors gracefully."""
    with patch("src.pipeline.qdrant") as mock_qdrant, \
         patch("src.pipeline.adapter") as mock_adapter:
        
        # Make adapter raise an error
        mock_adapter.extract_metadata = AsyncMock(side_effect=Exception("Test error"))
        
        # Should raise the exception
        with pytest.raises(Exception):
            await process_task(mock_task)
        
        # Verify status was set to failed
        calls = [call for call in mock_qdrant.set_payload.call_args_list 
                 if "enrichmentStatus" in call[1].get("payload", {})]
        
        # Should have at least one status update
        assert len(calls) > 0


@pytest.mark.asyncio
async def test_run_document_level_extraction():
    """Test document-level extraction."""
    with patch("src.pipeline.qdrant") as mock_qdrant, \
         patch("src.pipeline.adapter") as mock_adapter, \
         patch("src.pipeline.graph") as mock_graph:
        
        # Mock Qdrant retrieve
        mock_qdrant.retrieve.return_value = [
            MagicMock(payload={"text": "test text"})
        ]
        
        # Mock adapter responses
        mock_adapter.extract_metadata = AsyncMock(return_value={
            "summary": "Test"
        })
        mock_adapter.extract_entities = AsyncMock(return_value={
            "entities": [{"name": "TestEntity", "type": "class", "description": "Test"}],
            "relationships": []
        })
        
        # Mock graph operations
        mock_graph.upsert_document = AsyncMock()
        mock_graph.upsert_entity = AsyncMock()
        mock_graph.add_mention = AsyncMock()
        
        # Run extraction
        await run_document_level_extraction(
            "base-id",
            "docs",
            "code",
            1,
            "test.py"
        )
        
        # Verify graph operations were called
        assert mock_graph.upsert_document.called
        assert mock_graph.upsert_entity.called
        assert mock_graph.add_mention.called
