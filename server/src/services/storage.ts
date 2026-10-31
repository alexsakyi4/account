/**
 * Attachment storage.
 *
 * Local disk is the default (mount a volume or use the Docker image's
 * /app/uploads). Set STORAGE_DRIVER=s3 and provide S3_* variables to hand
 * uploads to any S3-compatible bucket — receipts never live in the database.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';

export interface StoredFile {
  key: string;
  sha256: string;
  size: number;
}

function safeName(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
}

export async function putFile(tenantId: string, filename: string, data: Buffer): Promise<StoredFile> {
  const sha256 = createHash('sha256').update(data).digest('hex');
  const key = path.join(tenantId, `${randomUUID()}-${safeName(filename)}`);
  if (process.env.STORAGE_DRIVER === 's3') {
    throw new Error('S3 storage adapter is not configured. Provide an S3 client implementation in services/storage.ts.');
  }
  if (config.serverless) {
    throw new AppError(
      501,
      'storage_unavailable',
      'Receipt storage is not configured for this deployment. Set STORAGE_DRIVER=s3 with a bucket, or run the container image with a persistent volume.',
    );
  }
  const target = path.join(config.uploadDir, key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
  return { key, sha256, size: data.byteLength };
}

export async function getFile(key: string): Promise<Buffer> {
  if (key.includes('..')) throw new Error('Invalid storage key');
  return readFile(path.join(config.uploadDir, key));
}

export async function deleteFile(key: string): Promise<void> {
  if (key.includes('..')) return;
  await unlink(path.join(config.uploadDir, key)).catch(() => undefined);
}
