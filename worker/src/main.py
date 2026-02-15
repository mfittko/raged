import asyncio
import json
import logging
import time
import redis.asyncio as aioredis
from src.config import (
    REDIS_URL,
    QUEUE_NAME,
    DEAD_LETTER_QUEUE,
    WORKER_CONCURRENCY,
    MAX_RETRIES,
)
from src.pipeline import process_task

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
logger = logging.getLogger(__name__)


async def process_task_with_retry(redis_client: aioredis.Redis, task: dict) -> None:
    """Process a task with retry logic and dead-letter handling.

    Args:
        redis_client: Redis client
        task: Task dictionary
    """
    task_id = task.get("taskId", "unknown")
    attempt = task.get("attempt", 1)

    # Check if task should be delayed for retry backoff
    retry_after = task.get("retryAfter", 0)
    if retry_after > time.time():
        delay = retry_after - time.time()
        logger.info(
            f"Task {task_id} delayed for {delay:.1f}s (retry backoff); sleeping before processing"
        )
        if delay > 0:
            await asyncio.sleep(delay)

    try:
        start_time = time.time()

        # Process the task
        await process_task(task)

        elapsed_ms = int((time.time() - start_time) * 1000)

        # Log structured completion event
        logger.info(
            json.dumps(
                {
                    "event": "enrichment_complete",
                    "taskId": task_id,
                    "baseId": task.get("baseId"),
                    "docType": task.get("docType"),
                    "chunkIndex": task.get("chunkIndex"),
                    "attempt": attempt,
                    "elapsed_ms": elapsed_ms,
                }
            )
        )

    except Exception as e:
        logger.error(f"Task {task_id} failed (attempt {attempt}/{MAX_RETRIES}): {e}")

        # Retry logic
        if attempt < MAX_RETRIES:
            # Increment attempt and re-queue with exponential backoff
            task["attempt"] = attempt + 1
            # Use attempt (not attempt-1) for proper exponential backoff: 2, 4, 8, 16, 32, 60
            task["retryAfter"] = time.time() + min(2**attempt, 60)
            await redis_client.rpush(QUEUE_NAME, json.dumps(task))
            logger.info(f"Re-queued task {task_id} for retry {attempt + 1}")
        else:
            # Move to dead-letter queue
            await redis_client.lpush(DEAD_LETTER_QUEUE, json.dumps(task))
            logger.error(
                f"Task {task_id} moved to dead-letter queue after {MAX_RETRIES} attempts"
            )


async def worker_task(redis_client: aioredis.Redis) -> None:
    """Worker task that processes items from the queue.

    Args:
        redis_client: Redis client
    """
    while True:
        try:
            # Wait for a task from the queue (blocking)
            _, raw = await redis_client.brpop(QUEUE_NAME)
            task = json.loads(raw)

            # Process the task
            await process_task_with_retry(redis_client, task)

        except Exception as e:
            logger.error(f"Error in worker task: {e}", exc_info=True)
            # Brief pause before retrying to avoid tight error loop
            await asyncio.sleep(1)


async def worker_loop() -> None:
    """Main worker loop with multiple concurrent tasks."""
    redis_client = aioredis.from_url(REDIS_URL)

    logger.info(f"Worker started with concurrency={WORKER_CONCURRENCY}")
    logger.info(f"Listening on queue: {QUEUE_NAME}")
    logger.info(f"Dead-letter queue: {DEAD_LETTER_QUEUE}")

    # Create fixed number of worker tasks for concurrency control
    # Each worker processes one task at a time from the queue
    workers = [
        asyncio.create_task(worker_task(redis_client))
        for _ in range(WORKER_CONCURRENCY)
    ]

    try:
        # Wait for all workers (they run forever)
        await asyncio.gather(*workers)
    except KeyboardInterrupt:
        logger.info("Shutting down worker...")
        # Cancel all worker tasks
        for worker in workers:
            worker.cancel()
        # Wait for cancellation to complete
        await asyncio.gather(*workers, return_exceptions=True)
    finally:
        await redis_client.close()
        # Close Neo4j driver
        from src import graph

        await graph.close_driver()


def main():
    """Entry point for the enrichment worker."""
    try:
        asyncio.run(worker_loop())
    except KeyboardInterrupt:
        logger.info("Worker stopped by user")


if __name__ == "__main__":
    main()
