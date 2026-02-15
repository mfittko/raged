"""Tests for the enrichment pipeline."""

from unittest.mock import AsyncMock, patch

import pytest

from src.pipeline import (
    aggregate_chunks,
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
        patch("src.pipeline.db") as mock_db,
        patch("src.pipeline.adapter") as mock_adapter,
    ):
        # Mock db operations
        mock_db.get_document_id_by_base_id = AsyncMock(return_value="doc-uuid-1")
        mock_db.update_chunk_status = AsyncMock()
        mock_db.update_chunk_tier2 = AsyncMock()
        mock_db.update_chunk_tier3 = AsyncMock()
        mock_db.update_document_summary = AsyncMock()
        mock_db.upsert_entity = AsyncMock(return_value="entity-uuid-1")
        mock_db.add_document_mention = AsyncMock()

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

        # Verify status updates were called
        assert mock_db.update_chunk_status.called


@pytest.mark.asyncio
async def test_process_task_multi_chunk(mock_task):
    """Test processing the last chunk of a multi-chunk document."""
    mock_task["chunkIndex"] = 2
    mock_task["totalChunks"] = 3
    mock_task["qdrantId"] = "repo:file.py:2"

    with (
        patch("src.pipeline.db") as mock_db,
        patch("src.pipeline.adapter") as mock_adapter,
    ):
        # Mock db operations
        mock_db.get_document_id_by_base_id = AsyncMock(return_value="doc-uuid-1")
        mock_db.update_chunk_status = AsyncMock()
        mock_db.update_chunk_tier2 = AsyncMock()
        mock_db.update_chunk_tier3 = AsyncMock()
        mock_db.get_chunks_text = AsyncMock(return_value=["chunk 0", "chunk 1", "chunk 2"])
        mock_db.update_document_summary = AsyncMock()
        mock_db.upsert_entity = AsyncMock(return_value="entity-uuid-1")

        # Mock adapter responses
        mock_adapter.extract_metadata = AsyncMock(return_value={"summary": "Test function"})
        mock_adapter.extract_entities = AsyncMock(
            return_value={"entities": [], "relationships": []}
        )

        # Process the task
        await process_task(mock_task)

        # Verify document-level extraction was triggered
        assert mock_adapter.extract_metadata.called


@pytest.mark.asyncio
async def test_aggregate_chunks():
    """Test chunk aggregation."""
    with patch("src.pipeline.db") as mock_db:
        mock_db.get_chunks_text = AsyncMock(return_value=["chunk 0", "chunk 1"])

        result = await aggregate_chunks("doc-uuid-1", 2)

        # Should have made a call to get_chunks_text
        assert mock_db.get_chunks_text.call_count == 1
        assert isinstance(result, str)
        # Aggregated result should contain all chunk texts
        assert "chunk 0" in result
        assert "chunk 1" in result


@pytest.mark.asyncio
async def test_process_task_handles_error(mock_task):
    """Test that process_task handles errors gracefully."""
    with patch("src.pipeline.db") as mock_db:
        # Mock db to return document ID
        mock_db.get_document_id_by_base_id = AsyncMock(return_value="doc-uuid-1")
        mock_db.update_chunk_status = AsyncMock()
        mock_db.update_chunk_tier2 = AsyncMock()

        # Make adapter raise an error during tier2 update
        # Set update_chunk_tier2 to raise an error instead
        mock_db.update_chunk_tier2.side_effect = RuntimeError("Test error")

        # Should raise the exception
        with pytest.raises(RuntimeError):
            await process_task(mock_task)

        # Verify status was set to failed
        failed_calls = [
            call
            for call in mock_db.update_chunk_status.call_args_list
            if len(call[0]) >= 3 and call[0][2] == "failed"
        ]

        # Should have at least one failed status update
        assert len(failed_calls) > 0


@pytest.mark.asyncio
async def test_run_document_level_extraction():
    """Test document-level extraction."""
    with (
        patch("src.pipeline.db") as mock_db,
        patch("src.pipeline.adapter") as mock_adapter,
    ):
        # Mock db operations
        mock_db.get_chunks_text = AsyncMock(return_value=["test text"])
        mock_db.update_chunk_tier3 = AsyncMock()
        mock_db.update_document_summary = AsyncMock()
        mock_db.upsert_entity = AsyncMock(return_value="entity-uuid-1")
        mock_db.add_document_mention = AsyncMock()
        mock_db.update_entity_mention_counts = AsyncMock()

        # Mock adapter responses
        mock_adapter.extract_metadata = AsyncMock(return_value={"summary": "Test"})
        mock_adapter.extract_entities = AsyncMock(
            return_value={
                "entities": [{"name": "TestEntity", "type": "class", "description": "Test"}],
                "relationships": [],
            }
        )

        # Run extraction
        await run_document_level_extraction("doc-uuid-1", "base-id", "code", 1, "test.py")

        # Verify db operations were called
        assert mock_db.update_document_summary.called
        assert mock_db.upsert_entity.called
        assert mock_db.add_document_mention.called
        assert mock_db.update_entity_mention_counts.called


@pytest.mark.asyncio
async def test_run_document_level_extraction_raises_on_chunk_update_failure():
    """Test document-level extraction fails when any tier-3 chunk update fails."""
    with (
        patch("src.pipeline.db") as mock_db,
        patch("src.pipeline.adapter") as mock_adapter,
    ):
        mock_db.get_chunks_text = AsyncMock(return_value=["chunk-0", "chunk-1"])
        mock_db.update_chunk_tier3 = AsyncMock(side_effect=[None, RuntimeError("boom")])
        mock_db.update_chunk_status = AsyncMock()

        mock_adapter.extract_metadata = AsyncMock(return_value={"summary": "Test"})
        mock_adapter.extract_entities = AsyncMock(
            return_value={"entities": [], "relationships": []}
        )

        with pytest.raises(RuntimeError, match="Tier-3 update failed"):
            await run_document_level_extraction("doc-uuid-1", "base-id", "code", 2, "test.py")

        failed_calls = [
            call
            for call in mock_db.update_chunk_status.call_args_list
            if len(call[0]) >= 3 and call[0][2] == "failed"
        ]
        assert len(failed_calls) == 1


@pytest.mark.asyncio
async def test_process_task_document_not_found(mock_task):
    """Test that process_task handles missing document gracefully."""
    with patch("src.pipeline.db") as mock_db:
        # Mock db to return None for document ID
        mock_db.get_document_id_by_base_id = AsyncMock(return_value=None)

        # Should raise ValueError
        with pytest.raises(ValueError, match="Document not found"):
            await process_task(mock_task)
