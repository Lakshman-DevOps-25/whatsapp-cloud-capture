/**
 * mediaService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Downloads inbound WhatsApp media and stores it in:
 *   - local disk  (MEDIA_STORAGE=local)  → ./uploads/<type>/<filename>
 *   - MinIO       (MEDIA_STORAGE=minio)  → bucket/whatsapp/<type>/<filename>
 *
 * MinIO bucket existence is checked LAZILY on first upload — not at startup.
 * This prevents the app from crashing if play.min.io rejects bucketExists()
 * during boot (common issue with the demo server).
 */

import axios from 'axios';
import path from 'path';
import { createWriteStream, mkdirSync } from 'fs';
import { pipeline } from 'stream/promises';
import { PassThrough } from 'stream';
import { getMinioClient, objectUrl } from '../config/minioClient.js';

// All env vars read lazily inside functions — not at module load time
const BASE_URL   = () => `https://graph.facebook.com/${process.env.WA_API_VERSION}`;
const TOKEN      = () => process.env.WA_ACCESS_TOKEN;
const STORAGE    = () => (process.env.MEDIA_STORAGE || 'local').trim().toLowerCase();
const UPLOAD_DIR = () => process.env.UPLOAD_DIR || './uploads';
const BUCKET     = () => (process.env.MINIO_BUCKET || 'whatsapp-media').trim();

// Tracks whether we have already verified the bucket exists this session
let _bucketVerified = false;

// ─── Startup config validation (called from app.js) ──────────────────────────
export function validateMediaConfig() {
  const storage = STORAGE();
  if (storage === 'minio') {
    const required = [
      'MINIO_INTERNAL_URL',
      'MINIO_ACCESS_KEY',
      'MINIO_SECRET_KEY',
      'MINIO_BUCKET',
      'MINIO_PUBLIC_URL',
    ];
    const missing = required.filter(k => !process.env[k] || !process.env[k].trim());
    if (missing.length) {
      throw new Error(
        `MEDIA_STORAGE=minio but these env vars are missing or empty: ${missing.join(', ')}`
      );
    }
    console.log(`✅ Media storage  : MinIO`);
    console.log(`   Internal URL   : ${process.env.MINIO_INTERNAL_URL}`);
    console.log(`   Public URL     : ${process.env.MINIO_PUBLIC_URL}`);
    console.log(`   Bucket         : ${process.env.MINIO_BUCKET}`);
  } else {
    console.log(`✅ Media storage  : local → ${UPLOAD_DIR()}`);
  }
}

// ─── MIME → extension ────────────────────────────────────────────────────────
const MIME_EXT = {
  'image/jpeg':            'jpg',
  'image/png':             'png',
  'image/webp':            'webp',
  'image/gif':             'gif',
  'video/mp4':             'mp4',
  'video/3gpp':            '3gp',
  'audio/ogg':             'ogg',
  'audio/ogg; codecs=opus':'ogg',
  'audio/mpeg':            'mp3',
  'audio/mp4':             'm4a',
  'audio/aac':             'aac',
  'application/pdf':       'pdf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/msword':    'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

export function extFromMime(mime) {
  return MIME_EXT[mime] || 'bin';
}

export function mediaTypeFolder(mime) {
  if (!mime) return 'other';
  if (mime.startsWith('image/'))  return 'images';
  if (mime.startsWith('video/'))  return 'videos';
  if (mime.startsWith('audio/'))  return 'audio';
  return 'documents';
}

// ─── Step 1: Resolve WhatsApp media download URL ─────────────────────────────
export async function resolveMediaUrl(mediaId) {
  const { data } = await axios.get(`${BASE_URL()}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN()}` },
  });
  return data; // { url, mime_type, sha256, file_size, id }
}

// ─── Step 2a: Save to local disk ─────────────────────────────────────────────
async function saveLocal(downloadUrl, mime, fileName) {
  const folder    = path.join(UPLOAD_DIR(), mediaTypeFolder(mime));
  mkdirSync(folder, { recursive: true });
  const localPath = path.join(folder, fileName);

  const response = await axios.get(downloadUrl, {
    responseType: 'stream',
    headers: { Authorization: `Bearer ${TOKEN()}` },
  });

  await pipeline(response.data, createWriteStream(localPath));
  console.log(`   💾 Local: saved → ${localPath}`);
  return { localPath };
}

// ─── Step 2b: Stream WhatsApp CDN → MinIO ────────────────────────────────────
async function saveMinIO(downloadUrl, mime, fileName, fileSize) {
  const minioClient = getMinioClient();
  const bucket      = BUCKET();
  const folder      = mediaTypeFolder(mime);
  const objectKey   = `whatsapp/${folder}/${fileName}`;

  // ── Lazy bucket verification (only once per session) ──────────────────────
  if (!_bucketVerified) {
    try {
      const exists = await minioClient.bucketExists(bucket);
      if (!exists) {
        throw new Error(
          `Bucket "${bucket}" not found on MinIO server.\n` +
          `→ Create it manually at: https://play.min.io:9443 (Buckets → Create Bucket)\n` +
          `→ Then set its Access Policy to "Public"`
        );
      }
      _bucketVerified = true;
      console.log(`✅ MinIO: bucket "${bucket}" verified`);

      // Try to apply public-read policy (may be blocked on play.min.io — not fatal)
      try {
        const policy = JSON.stringify({
          Version: '2012-10-17',
          Statement: [{
            Effect:    'Allow',
            Principal: { AWS: ['*'] },
            Action:    ['s3:GetObject'],
            Resource:  [`arn:aws:s3:::${bucket}/*`],
          }],
        });
        await minioClient.setBucketPolicy(bucket, policy);
        console.log(`✅ MinIO: public-read policy applied`);
      } catch (policyErr) {
        console.warn(`⚠️  MinIO: bucket policy not set (set it manually in Console): ${policyErr.message}`);
      }

    } catch (verifyErr) {
      // Throw with actionable message so it shows clearly in Railway logs
      throw new Error(
        `MinIO bucket check failed: ${verifyErr.message}\n\n` +
        `Check these Railway env vars:\n` +
        `  MINIO_INTERNAL_URL = ${process.env.MINIO_INTERNAL_URL || '(not set)'}\n` +
        `  MINIO_ACCESS_KEY   = ${process.env.MINIO_ACCESS_KEY ? '(set)' : '(NOT SET)'}\n` +
        `  MINIO_SECRET_KEY   = ${process.env.MINIO_SECRET_KEY ? '(set)' : '(NOT SET)'}\n` +
        `  MINIO_BUCKET       = ${process.env.MINIO_BUCKET || '(not set)'}`
      );
    }
  }

  // ── Stream Meta CDN → MinIO ───────────────────────────────────────────────
  const response = await axios.get(downloadUrl, {
    responseType: 'stream',
    headers: { Authorization: `Bearer ${TOKEN()}` },
  });

  const contentLength = parseInt(response.headers['content-length'] || fileSize || '-1');
  const pass = new PassThrough();
  response.data.pipe(pass);

  await minioClient.putObject(
    bucket,
    objectKey,
    pass,
    contentLength > 0 ? contentLength : undefined,
    { 'Content-Type': mime }
  );

  const minioUrl = objectUrl(objectKey);
  console.log(`   ✅ MinIO: stored  → ${objectKey}`);
  console.log(`   🌐 Public URL    → ${minioUrl}`);

  return { minioKey: objectKey, minioUrl };
}

// ─── Main export ──────────────────────────────────────────────────────────────
export async function downloadAndStoreMedia(mediaId, mime, hint = null) {
  const storage = STORAGE();
  console.log(`⬇️  Downloading media ${mediaId}  [storage: ${storage}]`);

  const meta     = await resolveMediaUrl(mediaId);
  const mimeType = meta.mime_type || mime || 'application/octet-stream';
  const ext      = extFromMime(mimeType);
  const fileName = hint || `${mediaId}.${ext}`;

  const result = storage === 'minio'
    ? await saveMinIO(meta.url, mimeType, fileName, meta.file_size)
    : await saveLocal(meta.url, mimeType, fileName);

  return {
    ...result,
    fileName,
    mimeType,
    sha256:       meta.sha256,
    fileSize:     meta.file_size,
    downloadedAt: new Date(),
  };
}
