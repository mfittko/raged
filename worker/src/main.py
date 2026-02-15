import asyncio
import logging
import os
import time

from src import db
from src.config import MAX_RETRIES, QUEUE_NAME, WORKER_CONCURRENCY
from src.pipeline import process_task

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(__name__)

# Generate unique worker ID
WORKER_ID = os.environ.get("HOSTNAME", f"worker-{os.getpid()}")


async def process_task_with_retry(task: dict) -> None:
    """Process a task with retry logic and dead-letter handling.

    Args:
        task: Task dictionary from database
    """
    task_id = task.get("taskId", "unknown")
    attempt = task.get("attempt", 1)

    try:
        start_time = time.time()

        # Process the task
        await process_task(task)

        elapsed_ms = int((time.time() - start_time) * 1000)

        # Mark as completed
        await db.complete_task(task_id)

        # Log structured completion event
        logger.info(
            f"enrichment_complete taskId={task_id} baseId={task.get('baseId')} "
            f"docType={task.get('docType')} chunkIndex={task.get('chunkIndex')} "
            f"attempt={attempt} elapsed_ms={elapsed_ms}"
        )

    except Exception as e:
        error_msg = str(e)
        logger.error(f"Task {task_id} failed (attempt {attempt}/{MAX_RETRIES}): {error_msg}")

        # Fail task - will retry or mark as dead based on attempt count
        await db.fail_task(task_id, error_msg, attempt, MAX_RETRIES)


async def worker_task() -> None:
    """Worker task that processes items from the queue using SKIP LOCKED polling."""
    while True:
        try:
            # Try to dequeue a task
            task = await db.dequeue_task(WORKER_ID)

            if task is None:
                # No tasks available - sleep to avoid busy-looping
                await asyncio.sleep(1)
                continue

            # Process the task
            await process_task_with_retry(task)

        except Exception as e:
            logger.error(f"Error in worker task: {e}", exc_info=True)
            # Brief pause before retrying to avoid tight error loop
            await asyncio.sleep(1)


async def watchdog_task() -> None:
    """Watchdog task that recovers stale leases every 60 seconds."""
    while True:
        try:
            await asyncio.sleep(60)
            await db.recover_stale_leases()
        except Exception as e:
            logger.error(f"Error in watchdog task: {e}", exc_info=True)


async def worker_loop() -> None:
    """Main worker loop with multiple concurrent tasks and watchdog."""
    logger.info(f"Worker started with concurrency={WORKER_CONCURRENCY}, id={WORKER_ID}")
    logger.info(f"Listening on queue: {QUEUE_NAME}")

    # Create fixed number of worker tasks for concurrency control
    # Each worker processes one task at a time from the queue
    workers = [asyncio.create_task(worker_task()) for _ in range(WORKER_CONCURRENCY)]

    # Add watchdog task for stale lease recovery
    watchdog = asyncio.create_task(watchdog_task())

    try:
        # Wait for all workers (they run forever)
        await asyncio.gather(*workers, watchdog)
    except KeyboardInterrupt:
        logger.info("Shutting down worker...")
        # Cancel all tasks
        for worker in workers:
            worker.cancel()
        watchdog.cancel()
        # Wait for cancellation to complete
        await asyncio.gather(*workers, watchdog, return_exceptions=True)
    finally:
        await db.close_pool()


def main():
    """Entry point for the enrichment worker."""
    try:
        asyncio.run(worker_loop())
    except KeyboardInterrupt:
        logger.info("Worker stopped by user")


if __name__ == "__main__":
    main()
