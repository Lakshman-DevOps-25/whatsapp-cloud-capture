/**
 * minioClient.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Singleton MinIO client.
 *
 * KEY CONFIG for play.min.io:
 *   MINIO_INTERNAL_URL = https://play.min.io:9000
 *   MINIO_PUBLIC_URL   = https://play.min.io:9000
 *   MINIO_ACCESS_KEY   = Q3AM3UQ867SPQQA43P2F
 *   MINIO_SECRET_KEY   = zuf+tfteSlswRu7BJ86wekitnifILbZam1KYY3TG
 *   MINIO_BUCKET       = whatsapp-media   ← must already exist in play.min.io Console
 *
 * For self-hosted MinIO:
 *   MINIO_INTERNAL_URL = http://localhost:9000  (or http://minio:9000 in Docker)
 *   MINIO_PUBLIC_URL   = http://your-server-ip:9000
 */

import { Client } from 'minio';

let _client = null;

function parseInternalUrl(rawUrl) {
  const url    = new URL((rawUrl || 'http://localhost:9000').trim());
  const useSSL = url.protocol === 'https:';
  const port   = url.port ? parseInt(url.port) : (useSSL ? 443 : 9000);
  return { endPoint: url.hostname, port, useSSL };
}

export function getMinioClient() {
  if (_client) return _client;

  const internalUrl = (process.env.MINIO_INTERNAL_URL || 'http://localhost:9000').trim();
  const { endPoint, port, useSSL } = parseInternalUrl(internalUrl);

  _client = new Client({
    endPoint,
    port,
    useSSL,
    pathStyle:  true,                                         // required for play.min.io + self-hosted
    accessKey:  (process.env.MINIO_ACCESS_KEY || '').trim(),
    secretKey:  (process.env.MINIO_SECRET_KEY || '').trim(),
  });

  console.log(`🗄  MinIO client → ${internalUrl}  (port=${port}, ssl=${useSSL}, pathStyle=true)`);
  return _client;
}

/**
 * Build a publicly accessible URL for a stored object.
 * Uses MINIO_PUBLIC_URL — the internet-facing address.
 */
export function objectUrl(objectKey) {
  const base   = (process.env.MINIO_PUBLIC_URL || 'http://localhost:9000').replace(/\/$/, '');
  const bucket = (process.env.MINIO_BUCKET     || 'whatsapp-media').trim();
  return `${base}/${bucket}/${objectKey}`;
}

/**
 * Generate a presigned GET URL (for private bucket access).
 * @param {string} objectKey
 * @param {number} [expirySeconds=3600]
 */
export async function presignedUrl(objectKey, expirySeconds = 3600) {
  const client = getMinioClient();
  const bucket = (process.env.MINIO_BUCKET || 'whatsapp-media').trim();
  return client.presignedGetObject(bucket, objectKey, expirySeconds);
}
