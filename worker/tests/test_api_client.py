"""Tests for API client HTTP communication."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from src.api_client import claim_task, close_client, fail_task, get_client, recover_stale, submit_result


@pytest.fixture
def mock_httpx_client():
    """Create a mock httpx async client."""
    client = MagicMock(spec=httpx.AsyncClient)
    client.post = AsyncMock()
    client.aclose = AsyncMock()
    return client


@pytest.mark.asyncio
async def test_claim_task_success(mock_httpx_client):
    """Test successful task claim."""
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "task": {
            "id": "task-uuid-123",
            "payload": {
                "baseId": "doc-123",
                "chunkIndex": 0,
                "totalChunks": 2,
                "docType": "text",
                "collection": "default",
            },
            "attempt": 1,
        },
        "chunks": [
            {"chunkIndex": 0, "text": "First chunk text"},
            {"chunkIndex": 1, "text": "Second chunk text"},
        ],
    }
    mock_response.raise_for_status = MagicMock()
    mock_httpx_client.post.return_value = mock_response

    with patch("src.api_client.get_client", return_value=mock_httpx_client):
        task = await claim_task("worker-1")

    assert task is not None
    assert task["taskId"] == "task-uuid-123"
    assert task["baseId"] == "doc-123"
    assert task["chunkIndex"] == 0
    assert task["totalChunks"] == 2
    assert task["text"] == "First chunk text"
    assert task["attempt"] == 1

    mock_httpx_client.post.assert_called_once_with(
        "/internal/tasks/claim",
        json={"workerId": "worker-1", "leaseDuration": 300},
    )


@pytest.mark.asyncio
async def test_claim_task_no_tasks_available(mock_httpx_client):
    """Test task claim when no tasks available."""
    mock_response = MagicMock()
    mock_response.json.return_value = {}  # Empty response when no tasks
    mock_response.raise_for_status = MagicMock()
    mock_httpx_client.post.return_value = mock_response

    with patch("src.api_client.get_client", return_value=mock_httpx_client):
        task = await claim_task("worker-1")

    assert task is None


@pytest.mark.asyncio
async def test_claim_task_http_error(mock_httpx_client):
    """Test task claim with HTTP error."""
    mock_response = MagicMock()
    mock_response.status_code = 500
    mock_response.text = "Internal Server Error"
    mock_httpx_client.post.return_value = mock_response
    mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
        "Server Error", request=MagicMock(), response=mock_response
    )

    with patch("src.api_client.get_client", return_value=mock_httpx_client):
        with pytest.raises(httpx.HTTPStatusError):
            await claim_task("worker-1")


@pytest.mark.asyncio
async def test_submit_result_success(mock_httpx_client):
    """Test successful result submission."""
    mock_response = MagicMock()
    mock_response.json.return_value = {"ok": True}
    mock_response.raise_for_status = MagicMock()
    mock_httpx_client.post.return_value = mock_response

    tier2 = {"entities": [], "keywords": [], "language": "en"}
    tier3 = {"summary": "Test summary"}
    entities = [{"name": "Entity1", "type": "person", "description": "Test entity"}]
    relationships = [{"source": "E1", "target": "E2", "type": "knows", "description": ""}]

    with patch("src.api_client.get_client", return_value=mock_httpx_client):
        await submit_result(
            task_id="task-123",
            chunk_id="doc-123:0",
            collection="default",
            tier2=tier2,
            tier3=tier3,
            entities=entities,
            relationships=relationships,
            summary="Test summary",
        )

    mock_httpx_client.post.assert_called_once()
    call_args = mock_httpx_client.post.call_args
    assert call_args[0][0] == "/internal/tasks/task-123/result"
    
    payload = call_args[1]["json"]
    assert payload["chunkId"] == "doc-123:0"
    assert payload["collection"] == "default"
    assert payload["tier2"] == tier2
    assert payload["tier3"] == tier3
    assert payload["entities"] == entities
    assert payload["relationships"] == relationships
    assert payload["summary"] == "Test summary"


@pytest.mark.asyncio
async def test_submit_result_minimal(mock_httpx_client):
    """Test result submission with only required fields."""
    mock_response = MagicMock()
    mock_response.json.return_value = {"ok": True}
    mock_response.raise_for_status = MagicMock()
    mock_httpx_client.post.return_value = mock_response

    with patch("src.api_client.get_client", return_value=mock_httpx_client):
        await submit_result(
            task_id="task-123",
            chunk_id="doc-123:0",
            collection="default",
        )

    call_args = mock_httpx_client.post.call_args
    payload = call_args[1]["json"]
    assert payload["chunkId"] == "doc-123:0"
    assert payload["collection"] == "default"
    assert "tier2" not in payload
    assert "tier3" not in payload


@pytest.mark.asyncio
async def test_fail_task_success(mock_httpx_client):
    """Test successful task failure reporting."""
    mock_response = MagicMock()
    mock_response.json.return_value = {"ok": True}
    mock_response.raise_for_status = MagicMock()
    mock_httpx_client.post.return_value = mock_response

    with patch("src.api_client.get_client", return_value=mock_httpx_client):
        await fail_task("task-123", "Test error message")

    mock_httpx_client.post.assert_called_once_with(
        "/internal/tasks/task-123/fail",
        json={"error": "Test error message"},
    )


@pytest.mark.asyncio
async def test_recover_stale_success(mock_httpx_client):
    """Test successful stale task recovery."""
    mock_response = MagicMock()
    mock_response.json.return_value = {"recovered": 3}
    mock_response.raise_for_status = MagicMock()
    mock_httpx_client.post.return_value = mock_response

    with patch("src.api_client.get_client", return_value=mock_httpx_client):
        count = await recover_stale()

    assert count == 3
    mock_httpx_client.post.assert_called_once_with("/internal/tasks/recover-stale")


@pytest.mark.asyncio
async def test_recover_stale_no_tasks(mock_httpx_client):
    """Test stale recovery when no tasks recovered."""
    mock_response = MagicMock()
    mock_response.json.return_value = {"recovered": 0}
    mock_response.raise_for_status = MagicMock()
    mock_httpx_client.post.return_value = mock_response

    with patch("src.api_client.get_client", return_value=mock_httpx_client):
        count = await recover_stale()

    assert count == 0


@pytest.mark.asyncio
async def test_close_client():
    """Test client cleanup."""
    mock_client = MagicMock(spec=httpx.AsyncClient)
    mock_client.aclose = AsyncMock()

    with patch("src.api_client._client", mock_client):
        await close_client()
        mock_client.aclose.assert_called_once()
