/**
 * mediaService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles ALL media storage — both directions:
 *
 *   INBOUND  (customer → business):
 *     downloadAndStoreMedia(mediaId, mime)
 *     → downloads from WhatsApp CDN → saves to MinIO or local disk
 *
 *   OUTBOUND (business → customer):
 *     uploadUrlToMinIO(url, mime, fileName)
 *     → downloads from any public URL → saves to MinIO or local disk
 *
 *     storeFileToMinIO(filePath, mime)
 *     → reads local file → saves to MinIO or local disk
 */

import axios from 'axios';
import path from 'path';
import { createWriteStream, mkdirSync } from 'fs';
import { pipeline } from 'stream/promises';
import { PassThrough } from 'stream';
import { getMinioClient, objectUrl } from '../config/minioClient.js';

// ── All env vars read lazily (after dotenv loads) ─────────────────────────────
const BASE_URL   = () => `https://graph.facebook.com/${process.env.WA_API_VERSION}`;
const TOKEN      = () => process.env.WA_ACCESS_TOKEN;
const STORAGE    = () => (process.env.MEDIA_STORAGE || 'local').trim().toLowerCase();
const UPLOAD_DIR = () => process.env.UPLOAD_DIR || './uploads';
const BUCKET     = () => (process.env.MINIO_BUCKET || 'whatsapp-media').trim();

// ── MIME helpers ──────────────────────────────────────────────────────────────
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'audio/ogg': 'ogg', 'audio/ogg; codecs=opus': 'ogg',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'application/pdf': 'pdf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

export function extFromMime(mime) { return MIME_EXT[mime] || 'bin'; }

export function mediaTypeFolder(mime) {
  if (!mime) return 'other';
  if (mime.startsWith('image/')) return 'images';
  if (mime.startsWith('video/')) return 'videos';
  if (mime.startsWith('audio/')) return 'audio';
  return 'documents';
}

// ── Startup config validation ─────────────────────────────────────────────────
export function validateMediaConfig() {
  const storage = STORAGE();
  if (storage === 'minio') {
    const required = ['MINIO_INTERNAL_URL', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'MINIO_BUCKET', 'MINIO_PUBLIC_URL'];
    const missing  = required.filter(k => !(process.env[k] || '').trim());
    if (missing.length) throw new Error(`MEDIA_STORAGE=minio but missing: ${missing.join(', ')}`);
    console.log(`✅ Media storage  : MinIO`);
    console.log(`   Internal URL   : ${process.env.MINIO_INTERNAL_URL}`);
    console.log(`   Public URL     : ${process.env.MINIO_PUBLIC_URL}`);
    console.log(`   Bucket         : ${process.env.MINIO_BUCKET}`);
  } else {
    console.log(`✅ Media storage  : local → ${UPLOAD_DIR()}`);
  }
}

// ── Step 1: Resolve WhatsApp media URL from media ID ─────────────────────────
export async function resolveMediaUrl(mediaId) {
  const { data } = await axios.get(`${BASE_URL()}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN()}` },
    timeout: 10000,
  });
  return data; // { url, mime_type, sha256, file_size }
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE STORAGE PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

// Save a readable stream to local disk
async function streamToLocal(readableStream, mime, folder, fileName) {
  const dir       = path.join(UPLOAD_DIR(), folder);
  mkdirSync(dir, { recursive: true });
  const localPath = path.join(dir, fileName);
  await pipeline(readableStream, createWriteStream(localPath));
  console.log(`   💾 Local saved   → ${localPath}`);
  return { localPath };
}

// Save a readable stream to MinIO
async function streamToMinIO(readableStream, mime, objectKey, contentLength) {
  const minioClient = getMinioClient();
  const bucket      = BUCKET();

  // Verify bucket exists (throws with actionable message if not)
  let exists;
  try {
    exists = await minioClient.bucketExists(bucket);
  } catch (err) {
    throw new Error(
      `MinIO bucketExists failed: ${err.message}\n` +
      `→ Check MINIO_INTERNAL_URL=${process.env.MINIO_INTERNAL_URL}\n` +
      `→ Check credentials and that bucket "${bucket}" exists in play.min.io Console`
    );
  }

  if (!exists) {
    throw new Error(
      `MinIO bucket "${bucket}" not found.\n` +
      `→ Create it at https://play.min.io:9443 → Buckets → Create Bucket\n` +
      `→ Set Access Policy to Public`
    );
  }

  const pass = new PassThrough();
  readableStream.pipe(pass);

  await minioClient.putObject(
    bucket,
    objectKey,
    pass,
    contentLength > 0 ? contentLength : undefined,
    { 'Content-Type': mime }
  );

  const minioUrl = objectUrl(objectKey);
  console.log(`   ✅ MinIO stored  → ${objectKey}`);
  console.log(`   🌐 Public URL   → ${minioUrl}`);
  return { minioKey: objectKey, minioUrl };
}

// Dispatch stream to correct backend
async function storeStream(readableStream, mime, folder, fileName, contentLength = -1) {
  const objectKey = `${folder}/${fileName}`;
  if (STORAGE() === 'minio') {
    return streamToMinIO(readableStream, mime, objectKey, contentLength);
  } else {
    return streamToLocal(readableStream, mime, folder, fileName);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * INBOUND: Download WhatsApp media by media ID and store it.
 * Called from webhook.js when customer sends media to business.
 */
export async function downloadAndStoreMedia(mediaId, mime, hint = null) {
  console.log(`⬇️  Inbound media  ${mediaId}  [${STORAGE()}]`);

  const meta     = await resolveMediaUrl(mediaId);
  const mimeType = meta.mime_type || mime || 'application/octet-stream';
  const ext      = extFromMime(mimeType);
  const fileName = hint || `${mediaId}.${ext}`;
  const folder   = `whatsapp/inbound/${mediaTypeFolder(mimeType)}`;

  const response = await axios.get(meta.url, {
    responseType: 'stream',
    headers: { Authorization: `Bearer ${TOKEN()}` },
    timeout: 30000,
  });

  const contentLength = parseInt(response.headers['content-length'] || meta.file_size || '-1');
  const result = await storeStream(response.data, mimeType, folder, fileName, contentLength);

  return { ...result, fileName, mimeType, sha256: meta.sha256, fileSize: meta.file_size, downloadedAt: new Date() };
}

/**
 * OUTBOUND via URL: Download from a public URL and store it in MinIO/local.
 * Called from whatsappService.js when business sends media by URL.
 */
export async function downloadUrlAndStore(url, mime, folder, fileName) {
  console.log(`⬇️  Outbound URL   ${url}  [${STORAGE()}]`);

  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 30000,
  });

  const mimeType      = mime || response.headers['content-type']?.split(';')[0] || 'application/octet-stream';
  const contentLength = parseInt(response.headers['content-length'] || '-1');
  const ext           = extFromMime(mimeType);
  const resolvedName  = fileName || `${Date.now()}.${ext}`;
  const resolvedFolder = folder || `whatsapp/outbound/${mediaTypeFolder(mimeType)}`;

  const result = await storeStream(response.data, mimeType, resolvedFolder, resolvedName, contentLength);
  return { ...result, fileName: resolvedName, mimeType, downloadedAt: new Date() };
}

/**
 * OUTBOUND via file: Read a local temp file and store it in MinIO/local.
 * Called from whatsappService.js when business sends media by file upload.
 */
export async function storeLocalFile(filePath, mime) {
  console.log(`📁 Outbound file  ${filePath}  [${STORAGE()}]`);
  const fs       = await import('fs');
  const mimeType = mime || 'application/octet-stream';
  const ext      = extFromMime(mimeType);
  const fileName = `${Date.now()}-${path.basename(filePath)}`;
  const folder   = `whatsapp/outbound/${mediaTypeFolder(mimeType)}`;
  const fileSize = fs.statSync(filePath).size;

  if (STORAGE() === 'minio') {
    const objectKey   = `${folder}/${fileName}`;
    const minioClient = getMinioClient();
    const bucket      = BUCKET();

    // Verify bucket
    let exists;
    try { exists = await minioClient.bucketExists(bucket); }
    catch (err) { throw new Error(`MinIO bucketExists failed: ${err.message}`); }
    if (!exists) throw new Error(`MinIO bucket "${bucket}" not found. Create it at https://play.min.io:9443`);

    await minioClient.putObject(bucket, objectKey, fs.createReadStream(filePath), fileSize, { 'Content-Type': mimeType });
    const minioUrl = objectUrl(objectKey);
    console.log(`   ✅ MinIO stored  → ${objectKey}`);
    console.log(`   🌐 Public URL   → ${minioUrl}`);
    return { minioKey: objectKey, minioUrl, fileName, mimeType, fileSize, downloadedAt: new Date() };
  } else {
    const dir       = path.join(UPLOAD_DIR(), folder);
    mkdirSync(dir, { recursive: true });
    const localPath = path.join(dir, fileName);
    await fs.promises.copyFile(filePath, localPath);
    console.log(`   💾 Local saved   → ${localPath}`);
    return { localPath, fileName, mimeType, fileSize, downloadedAt: new Date() };
  }
}
