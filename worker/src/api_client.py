"""HTTP client for communicating with the API's internal endpoints."""

import logging
from typing import Any

import httpx

from src.config import API_TOKEN, API_URL

logger = logging.getLogger(__name__)

# Global HTTP client
_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    """Get or create the httpx async client.

    Returns:
        httpx async client with configured base URL and auth
    """
    global _client
    if _client is None:
        headers = {}
        if API_TOKEN:
            headers["Authorization"] = f"Bearer {API_TOKEN}"

        _client = httpx.AsyncClient(
            base_url=API_URL,
            headers=headers,
            timeout=httpx.Timeout(60.0),
            http2=True,
        )
        logger.info(f"HTTP client created for API: {API_URL}")
    return _client


async def close_client() -> None:
    """Close the HTTP client."""
    global _client
    if _client:
        await _client.aclose()
        _client = None
        logger.info("HTTP client closed")


async def claim_task(worker_id: str) -> dict[str, Any] | None:
    """Claim next available task from the enrichment queue.

    Args:
        worker_id: Unique identifier for this worker instance

    Returns:
        Task dictionary with chunk texts if a task was claimed, None if no tasks available
    """
    client = get_client()

    try:
        response = await client.post(
            "/internal/tasks/claim",
            json={"workerId": worker_id, "leaseDuration": 300},
        )
        response.raise_for_status()

        data = response.json()

        # No task available
        if not data.get("task"):
            return None

        task_data = data["task"]
        chunks = data.get("chunks", [])

        # Build task payload combining task metadata and chunks
        payload = task_data.get("payload", {})

        # Find the chunk text for this specific chunk
        chunk_index = payload.get("chunkIndex", 0)
        chunk_text = ""
        for chunk in chunks:
            if chunk.get("chunkIndex") == chunk_index:
                chunk_text = chunk.get("text", "")
                break

        # Build task object matching the legacy format
        task = {
            **payload,
            "taskId": task_data["id"],
            "attempt": task_data["attempt"],
            "text": chunk_text,
        }

        return task

    except httpx.HTTPStatusError as e:
        logger.error(f"HTTP error claiming task: {e.response.status_code} {e.response.text}")
        raise
    except Exception as e:
        logger.error(f"Error claiming task: {e}")
        raise


async def submit_result(
    task_id: str,
    chunk_id: str,
    collection: str,
    tier2: dict | None = None,
    tier3: dict | None = None,
    entities: list[dict] | None = None,
    relationships: list[dict] | None = None,
    summary: str | None = None,
) -> None:
    """Submit enrichment results for a task.

    Args:
        task_id: Task ID (UUID as string)
        chunk_id: Chunk identifier in format "baseId:chunkIndex"
        collection: Collection name
        tier2: Tier 2 enrichment data
        tier3: Tier 3 enrichment data
        entities: List of extracted entities
        relationships: List of entity relationships
        summary: Document summary
    """
    client = get_client()

    payload: dict[str, Any] = {
        "chunkId": chunk_id,
        "collection": collection,
    }

    if tier2 is not None:
        payload["tier2"] = tier2
    if tier3 is not None:
        payload["tier3"] = tier3
    if entities is not None:
        payload["entities"] = entities
    if relationships is not None:
        payload["relationships"] = relationships
    if summary is not None:
        payload["summary"] = summary

    try:
        response = await client.post(
            f"/internal/tasks/{task_id}/result",
            json=payload,
        )
        response.raise_for_status()

        logger.debug(f"Successfully submitted result for task {task_id}")

    except httpx.HTTPStatusError as e:
        logger.error(f"HTTP error submitting result: {e.response.status_code} {e.response.text}")
        raise
    except Exception as e:
        logger.error(f"Error submitting result: {e}")
        raise


async def fail_task(task_id: str, error_msg: str) -> None:
    """Report task failure to the API.

    The API handles retry logic and dead-letter queue management.

    Args:
        task_id: Task ID (UUID as string)
        error_msg: Error message
    """
    client = get_client()

    try:
        response = await client.post(
            f"/internal/tasks/{task_id}/fail",
            json={"error": error_msg},
        )
        response.raise_for_status()

        logger.debug(f"Successfully reported failure for task {task_id}")

    except httpx.HTTPStatusError as e:
        logger.error(f"HTTP error reporting failure: {e.response.status_code} {e.response.text}")
        raise
    except Exception as e:
        logger.error(f"Error reporting failure: {e}")
        raise


async def recover_stale() -> int:
    """Recover tasks with expired leases (watchdog pattern).

    Returns:
        Number of tasks recovered
    """
    client = get_client()

    try:
        response = await client.post("/internal/tasks/recover-stale")
        response.raise_for_status()

        data = response.json()
        count = data.get("recovered", 0)

        if count > 0:
            logger.warning(f"Recovered {count} stale task(s) with expired leases")

        return count

    except httpx.HTTPStatusError as e:
        logger.error(
            f"HTTP error recovering stale tasks: {e.response.status_code} {e.response.text}"
        )
        raise
    except Exception as e:
        logger.error(f"Error recovering stale tasks: {e}")
        raise
