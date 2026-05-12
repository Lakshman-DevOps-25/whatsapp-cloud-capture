/**
 * minioClient.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Singleton MinIO client.
 * On first import it:
 *   1. Creates the MinIO Client instance
 *   2. Ensures the configured bucket exists (creates it if missing)
 *   3. Sets a public read policy on the bucket so object URLs are directly
 *      accessible from a browser (you can remove/tighten this for private use)
 */

import { Client } from 'minio';

let _client = null;

export function getMinioClient() {
  if (_client) return _client;

  _client = new Client({
    endPoint:  process.env.MINIO_ENDPOINT  || 'localhost',
    port:      parseInt(process.env.MINIO_PORT || '9000'),
    useSSL:    process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  });

  return _client;
}

/**
 * Call once at startup to guarantee the bucket exists.
 * Safe to call multiple times — idempotent.
 */
export async function ensureBucket() {
  const client = getMinioClient();
  const bucket = process.env.MINIO_BUCKET || 'whatsapp-media';

  const exists = await client.bucketExists(bucket);
  if (!exists) {
    await client.makeBucket(bucket, '');
    console.log(`✅ MinIO: created bucket "${bucket}"`);
  } else {
    console.log(`✅ MinIO: bucket "${bucket}" ready`);
  }

  // Set anonymous read policy so URLs work without signed tokens.
  // Remove this block if you want private (presigned URL) access instead.
  const policy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect:    'Allow',
        Principal: { AWS: ['*'] },
        Action:    ['s3:GetObject'],
        Resource:  [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  });
  await client.setBucketPolicy(bucket, policy);
}

/**
 * Build the public URL for a stored object.
 * Uses MINIO_PUBLIC_URL so you can put a CDN or reverse proxy in front.
 */
export function objectUrl(objectKey) {
  const base   = (process.env.MINIO_PUBLIC_URL || 'http://localhost:9000').replace(/\/$/, '');
  const bucket = process.env.MINIO_BUCKET || 'whatsapp-media';
  return `${base}/${bucket}/${objectKey}`;
}

/**
 * Generate a short-lived presigned GET URL (useful for private buckets).
 * @param {string} objectKey
 * @param {number} [expirySeconds=3600]
 */
export async function presignedUrl(objectKey, expirySeconds = 3600) {
  const client = getMinioClient();
  const bucket = process.env.MINIO_BUCKET || 'whatsapp-media';
  return client.presignedGetObject(bucket, objectKey, expirySeconds);
}
