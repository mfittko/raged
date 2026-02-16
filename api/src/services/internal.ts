// Internal endpoints for worker communication
// These endpoints allow the worker to claim tasks and submit results

import { getPool } from "../db.js";

export interface TaskClaimRequest {
  workerId?: string;
  leaseDuration?: number; // seconds
}

export interface TaskClaimResult {
  task?: {
    id: string;
    payload: Record<string, unknown>;
    attempt: number;
  };
  chunks?: Array<{
    chunkIndex: number;
    text: string;
  }>;
}

export interface TaskResultRequest {
  chunkId: string;
  collection: string;
  tier2?: Record<string, unknown>;
  tier3?: Record<string, unknown>;
  entities?: Array<{
    name: string;
    type: string;
    description?: string;
  }>;
  relationships?: Array<{
    source: string;
    target: string;
    type: string;
    description?: string;
  }>;
  summary?: string;
}

export interface TaskFailRequest {
  error: string;
}

/**
 * Claim next available task from the queue using SKIP LOCKED
 */
export async function claimTask(request: TaskClaimRequest): Promise<TaskClaimResult> {
  const pool = getPool();
  const workerId = request.workerId || "unknown";
  const leaseDuration = request.leaseDuration || 300; // 5 minutes default

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Dequeue next task with SKIP LOCKED
    const result = await client.query<{
      id: string;
      payload: Record<string, unknown>;
      attempt: number;
    }>(
      `UPDATE task_queue
       SET status = 'processing',
           leased_by = $1,
           lease_expires_at = now() + interval '1 second' * $2,
           started_at = now(),
           attempt = attempt + 1
       WHERE id = (
         SELECT id
         FROM task_queue
         WHERE queue = 'enrichment'
           AND status = 'pending'
           AND run_after <= now()
         ORDER BY run_after, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, payload, attempt`,
      [workerId, leaseDuration]
    );

    if (result.rows.length === 0) {
      await client.query("COMMIT");
      return {}; // No tasks available
    }

    const task = result.rows[0];
    const payload = task.payload as any;

    // Fetch chunk texts for the entire document
    const chunksResult = await client.query<{ chunk_index: number; text: string }>(
      `SELECT c.chunk_index, c.text
       FROM chunks c
       JOIN documents d ON c.document_id = d.id
       WHERE d.base_id = $1 AND d.collection = $2
       ORDER BY c.chunk_index`,
      [payload.baseId, payload.collection]
    );

    await client.query("COMMIT");

    return {
      task: {
        id: task.id,
        payload: task.payload,
        attempt: task.attempt,
      },
      chunks: chunksResult.rows.map(r => ({
        chunkIndex: r.chunk_index,
        text: r.text,
      })),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Submit enrichment results - writes all data in one transaction
 */
export async function submitTaskResult(taskId: string, result: TaskResultRequest): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Parse chunkId to get document base_id and chunk_index
    const chunkIdParts = result.chunkId.split(":");
    if (chunkIdParts.length !== 2) {
      throw new Error(`Invalid chunkId format: ${result.chunkId}`);
    }
    const baseId = chunkIdParts[0];
    const chunkIndex = parseInt(chunkIdParts[1], 10);

    // Update chunk with enrichment results
    await client.query(
      `UPDATE chunks c
       SET enrichment_status = 'enriched',
           enriched_at = now(),
           tier2_meta = $1,
           tier3_meta = $2
       FROM documents d
       WHERE c.document_id = d.id
         AND d.base_id = $3
         AND d.collection = $4
         AND c.chunk_index = $5`,
      [
        result.tier2 ? JSON.stringify(result.tier2) : null,
        result.tier3 ? JSON.stringify(result.tier3) : null,
        baseId,
        result.collection,
        chunkIndex,
      ]
    );

    // Get document_id for entity mentions
    const docResult = await client.query<{ id: string }>(
      `SELECT id FROM documents WHERE base_id = $1 AND collection = $2`,
      [baseId, result.collection]
    );

    if (docResult.rows.length === 0) {
      throw new Error(`Document not found for baseId: ${baseId}`);
    }

    const documentId = docResult.rows[0].id;

    // Upsert entities
    if (result.entities && result.entities.length > 0) {
      for (const entity of result.entities) {
        await client.query(
          `INSERT INTO entities (name, type, description)
           VALUES ($1, $2, $3)
           ON CONFLICT (name) DO UPDATE
           SET type = COALESCE(EXCLUDED.type, entities.type),
               description = COALESCE(EXCLUDED.description, entities.description),
               mention_count = entities.mention_count + 1,
               last_seen = now()`,
          [entity.name, entity.type, entity.description || null]
        );

        // Create document-entity mention
        await client.query(
          `INSERT INTO document_entity_mentions (document_id, entity_id, mention_count)
           SELECT $1, id, 1
           FROM entities
           WHERE name = $2
           ON CONFLICT (document_id, entity_id) DO UPDATE
           SET mention_count = document_entity_mentions.mention_count + 1`,
          [documentId, entity.name]
        );
      }
    }

    // Upsert relationships
    if (result.relationships && result.relationships.length > 0) {
      for (const rel of result.relationships) {
        await client.query(
          `INSERT INTO entity_relationships (source_id, target_id, relationship_type, description)
           SELECT 
             (SELECT id FROM entities WHERE name = $1),
             (SELECT id FROM entities WHERE name = $2),
             $3,
             $4
           ON CONFLICT (source_id, target_id, relationship_type) DO UPDATE
           SET description = COALESCE(EXCLUDED.description, entity_relationships.description)`,
          [rel.source, rel.target, rel.type, rel.description || null]
        );
      }
    }

    // Update document summary if provided
    if (result.summary) {
      await client.query(
        `UPDATE documents
         SET summary = $1
         WHERE base_id = $2 AND collection = $3`,
        [result.summary, baseId, result.collection]
      );
    }

    // Mark task as completed
    await client.query(
      `UPDATE task_queue
       SET status = 'completed',
           completed_at = now()
       WHERE id = $1`,
      [taskId]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Mark task as failed with retry/dead-letter logic
 */
export async function failTask(taskId: string, failRequest: TaskFailRequest): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Get current task state
    const taskResult = await client.query<{ attempt: number; max_attempts: number }>(
      `SELECT attempt, max_attempts FROM task_queue WHERE id = $1`,
      [taskId]
    );

    if (taskResult.rows.length === 0) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const { attempt, max_attempts } = taskResult.rows[0];

    if (attempt >= max_attempts) {
      // Move to dead-letter (dead status)
      await client.query(
        `UPDATE task_queue
         SET status = 'dead',
             error = $1,
             completed_at = now()
         WHERE id = $2`,
        [failRequest.error, taskId]
      );
    } else {
      // Retry with exponential backoff
      const retryDelaySeconds = Math.min(60 * Math.pow(2, attempt - 1), 3600); // Max 1 hour

      await client.query(
        `UPDATE task_queue
         SET status = 'pending',
             error = $1,
             run_after = now() + interval '1 second' * $2,
             leased_by = NULL,
             lease_expires_at = NULL
         WHERE id = $3`,
        [failRequest.error, retryDelaySeconds, taskId]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Recover stale tasks with expired leases (watchdog)
 */
export async function recoverStaleTasks(): Promise<{ recovered: number }> {
  const pool = getPool();

  const result = await pool.query<{ count: number }>(
    `UPDATE task_queue
     SET status = 'pending',
         leased_by = NULL,
         lease_expires_at = NULL,
         run_after = now()
     WHERE queue = 'enrichment'
       AND status = 'processing'
       AND lease_expires_at < now()
     RETURNING id`
  );

  return { recovered: result.rowCount || 0 };
}
