import { createClient } from "redis";

export interface EnrichmentTask {
  taskId: string;
  qdrantId: string;
  collection: string;
  docType: string;
  baseId: string;
  chunkIndex: number;
  totalChunks: number;
  text: string;
  source: string;
  tier1Meta: Record<string, unknown>;
  attempt: number;
  enqueuedAt: string;
}

const QUEUE_NAME = "enrichment:pending";
const ENRICHMENT_ENABLED =
  process.env.ENRICHMENT_ENABLED === "true" &&
  Boolean(process.env.REDIS_URL);

let redisClient: ReturnType<typeof createClient> | null = null;
let connectPromise: Promise<void> | null = null;

export function isEnrichmentEnabled(): boolean {
  return ENRICHMENT_ENABLED;
}

async function getRedisClient() {
  if (!isEnrichmentEnabled()) {
    throw new Error("Enrichment is not enabled or REDIS_URL is not set");
  }

  if (!redisClient) {
    redisClient = createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
    });
    redisClient.on("error", (err) => console.error("Redis error:", err));
    
    // Store connect promise to prevent race conditions
    if (!connectPromise) {
      connectPromise = redisClient.connect().then(() => {});
    }
  }

  // Always await the connect promise to ensure client is ready
  await connectPromise;
  return redisClient;
}

export async function enqueueEnrichment(
  task: EnrichmentTask,
): Promise<void> {
  if (!isEnrichmentEnabled()) {
    return; // Silently skip if enrichment is disabled
  }

  const client = await getRedisClient();
  await client.lPush(QUEUE_NAME, JSON.stringify(task));
}

export async function getQueueLength(queueName: string): Promise<number> {
  if (!isEnrichmentEnabled()) {
    return 0;
  }

  const client = await getRedisClient();
  return await client.lLen(queueName);
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    connectPromise = null;
  }
}
