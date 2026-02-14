import asyncio
import json
import logging
import redis.asyncio as aioredis
from src.config import REDIS_URL, QUEUE_NAME, WORKER_CONCURRENCY

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)

async def process_task(task_data: dict) -> None:
    """Process a single enrichment task. Implemented in later tasks."""
    logger.info(f"Processing task: {task_data.get('taskId', 'unknown')}")
    pass

async def worker_loop() -> None:
    """Main worker loop: dequeue and process tasks."""
    r = aioredis.from_url(REDIS_URL)
    logger.info(f"Worker started, listening on {QUEUE_NAME}")
    while True:
        _, raw = await r.brpop(QUEUE_NAME)
        task = json.loads(raw)
        await process_task(task)

def main():
    asyncio.run(worker_loop())

if __name__ == "__main__":
    main()
