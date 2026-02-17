import { createHash } from "node:crypto";
import path from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

interface BlobStoreConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  thresholdBytes: number;
}

export interface RawUploadInput {
  documentId: string;
  source: string;
  body: Buffer;
  mimeType: string;
}

export interface RawUploadResult {
  key: string;
  bytes: number;
  mimeType: string;
}

// Cached S3 client to avoid per-upload instantiation overhead
let cachedS3Client: S3Client | null = null;
let cachedConfigHash: string | null = null;

function getConfigHash(config: BlobStoreConfig): string {
  return `${config.endpoint}:${config.accessKeyId}:${config.bucket}:${config.region}`;
}

function getS3Client(config: BlobStoreConfig): S3Client {
  const configHash = getConfigHash(config);
  
  // Reuse existing client if config hasn't changed
  if (cachedS3Client && cachedConfigHash === configHash) {
    return cachedS3Client;
  }
  
  // Create new client and cache it
  cachedS3Client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  cachedConfigHash = configHash;
  
  return cachedS3Client;
}

function asNonEmptyEnv(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readThreshold(): number {
  const rawValue = process.env.BLOB_STORE_THRESHOLD_BYTES;
  if (!rawValue) {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return parsed;
}

export function getBlobStoreConfig(): BlobStoreConfig | null {
  const endpoint = asNonEmptyEnv(process.env.BLOB_STORE_URL);
  const accessKeyId = asNonEmptyEnv(process.env.BLOB_STORE_ACCESS_KEY);
  const secretAccessKey = asNonEmptyEnv(process.env.BLOB_STORE_SECRET_KEY);
  const bucket = asNonEmptyEnv(process.env.BLOB_STORE_BUCKET);

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    return null;
  }

  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region: process.env.BLOB_STORE_REGION || "us-east-1",
    thresholdBytes: readThreshold(),
  };
}

export function shouldStoreRawBlob(rawSizeBytes: number): boolean {
  const config = getBlobStoreConfig();
  if (!config) {
    return false;
  }

  return rawSizeBytes > config.thresholdBytes;
}

export async function uploadRawBlob(input: RawUploadInput): Promise<RawUploadResult> {
  const config = getBlobStoreConfig();
  if (!config) {
    throw new Error("blob store is not configured");
  }

  const body = input.body;
  const bytes = body.length;
  const hash = createHash("sha256").update(input.source).digest("hex").slice(0, 12);
  const sourceExt = path.extname(input.source).toLowerCase();
  const ext = sourceExt.length > 0 ? sourceExt : ".bin";
  const key = `documents/${input.documentId}/raw-${hash}${ext}`;
  const mimeType = input.mimeType;

  // Reuse cached S3 client instead of creating a new one per upload
  const client = getS3Client(config);

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: mimeType,
    }),
  );

  return {
    key,
    bytes,
    mimeType,
  };
}
