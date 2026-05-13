/**
 * mediaService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * All media storage — inbound AND outbound.
 *
 * INBOUND  (customer → business):
 *   downloadAndStoreMedia(mediaId, mime, hint)
 *   → fetches from WhatsApp CDN → saves to MinIO or local
 *
 * OUTBOUND (business → customer) via URL:
 *   downloadUrlAndStore(url, mime, objectKeyPrefix)
 *   → downloads public URL → saves to MinIO or local
 *
 * OUTBOUND (business → customer) via file upload:
 *   storeLocalFile(filePath, mime)
 *   → reads local temp file → saves to MinIO or local
 */

import axios       from 'axios';
import fs          from 'fs';                   // static import — no dynamic import
import path        from 'path';
import { createWriteStream, mkdirSync } from 'fs';
import { pipeline } from 'stream/promises';
import { PassThrough } from 'stream';
import { getMinioClient, objectUrl } from '../config/minioClient.js';

// ── Lazy env getters (read after dotenv loads) ────────────────────────────────
const BASE_URL   = () => `https://graph.facebook.com/${process.env.WA_API_VERSION}`;
const TOKEN      = () => process.env.WA_ACCESS_TOKEN;
const STORAGE    = () => (process.env.MEDIA_STORAGE || 'local').trim().toLowerCase();
const UPLOAD_DIR = () => process.env.UPLOAD_DIR || './uploads';
const BUCKET     = () => (process.env.MINIO_BUCKET || 'whatsapp-media').trim();

// ── MIME helpers ──────────────────────────────────────────────────────────────
const MIME_EXT = {
  'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif',
  'video/mp4':'mp4','video/3gpp':'3gp',
  'audio/ogg':'ogg','audio/ogg; codecs=opus':'ogg',
  'audio/mpeg':'mp3','audio/mp4':'m4a','audio/aac':'aac',
  'application/pdf':'pdf',
  'application/vnd.ms-excel':'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
  'application/msword':'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
};
export const extFromMime    = (mime) => MIME_EXT[mime] || 'bin';
export const mediaTypeFolder = (mime) => {
  if (!mime) return 'other';
  if (mime.startsWith('image/'))  return 'images';
  if (mime.startsWith('video/'))  return 'videos';
  if (mime.startsWith('audio/'))  return 'audio';
  return 'documents';
};

// ── Startup validation ────────────────────────────────────────────────────────
export function validateMediaConfig() {
  const storage = STORAGE();
  if (storage === 'minio') {
    const required = ['MINIO_INTERNAL_URL','MINIO_ACCESS_KEY','MINIO_SECRET_KEY','MINIO_BUCKET','MINIO_PUBLIC_URL'];
    const missing  = required.filter(k => !(process.env[k]||'').trim());
    if (missing.length) throw new Error(`MEDIA_STORAGE=minio but missing: ${missing.join(', ')}`);
    console.log(`✅ Media: MinIO → ${process.env.MINIO_INTERNAL_URL} | bucket: ${process.env.MINIO_BUCKET}`);
    console.log(`✅ Media: public → ${process.env.MINIO_PUBLIC_URL}`);
  } else {
    console.log(`✅ Media: local → ${UPLOAD_DIR()}`);
  }
}

// ── WhatsApp media URL resolver ───────────────────────────────────────────────
export async function resolveMediaUrl(mediaId) {
  const { data } = await axios.get(`${BASE_URL()}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN()}` },
    timeout: 10000,
  });
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: Save to MinIO
// ─────────────────────────────────────────────────────────────────────────────
async function putToMinIO(stream, mime, objectKey, contentLength) {
  const client = getMinioClient();
  const bucket = BUCKET();

  console.log(`   🗄  MinIO putObject → bucket=${bucket} key=${objectKey}`);

  // Verify bucket — throws with clear message if missing/wrong credentials
  let exists;
  try {
    exists = await client.bucketExists(bucket);
  } catch (err) {
    throw new Error(
      `MinIO bucketExists() failed: ${err.message}\n` +
      `  MINIO_INTERNAL_URL = ${process.env.MINIO_INTERNAL_URL}\n` +
      `  MINIO_ACCESS_KEY   = ${process.env.MINIO_ACCESS_KEY ? 'set' : 'MISSING'}\n` +
      `  MINIO_BUCKET       = ${bucket}`
    );
  }

  if (!exists) {
    throw new Error(
      `Bucket "${bucket}" not found on MinIO.\n` +
      `→ Login at https://play.min.io:9443 → Buckets → Create Bucket → Access: Public`
    );
  }

  const pass = new PassThrough();
  stream.pipe(pass);

  await client.putObject(
    bucket, objectKey, pass,
    contentLength > 0 ? contentLength : undefined,
    { 'Content-Type': mime }
  );

  const url = objectUrl(objectKey);
  console.log(`   ✅ MinIO stored  → ${objectKey}`);
  console.log(`   🌐 Public URL   → ${url}`);
  return { minioKey: objectKey, minioUrl: url };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: Save to local disk
// ─────────────────────────────────────────────────────────────────────────────
async function putToLocal(stream, folder, fileName) {
  const dir       = path.join(UPLOAD_DIR(), folder);
  mkdirSync(dir, { recursive: true });
  const localPath = path.join(dir, fileName);
  await pipeline(stream, createWriteStream(localPath));
  console.log(`   💾 Local saved  → ${localPath}`);
  return { localPath };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: INBOUND — download from WhatsApp CDN and store
// ─────────────────────────────────────────────────────────────────────────────
export async function downloadAndStoreMedia(mediaId, mime, hint = null) {
  const storage = STORAGE();
  console.log(`⬇️  [INBOUND] mediaId=${mediaId} storage=${storage}`);

  const meta     = await resolveMediaUrl(mediaId);
  const mimeType = meta.mime_type || mime || 'application/octet-stream';
  const fileName = hint || `${mediaId}.${extFromMime(mimeType)}`;
  const folder   = `whatsapp/inbound/${mediaTypeFolder(mimeType)}`;
  const objectKey = `${folder}/${fileName}`;

  const response = await axios.get(meta.url, {
    responseType: 'stream',
    headers: { Authorization: `Bearer ${TOKEN()}` },
    timeout: 30000,
  });
  const contentLength = parseInt(response.headers['content-length'] || meta.file_size || '-1');

  let result;
  if (storage === 'minio') {
    result = await putToMinIO(response.data, mimeType, objectKey, contentLength);
  } else {
    result = await putToLocal(response.data, folder, fileName);
  }

  return { ...result, fileName, mimeType, sha256: meta.sha256, fileSize: meta.file_size, downloadedAt: new Date() };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: OUTBOUND via URL — download URL content and store
// ─────────────────────────────────────────────────────────────────────────────
export async function downloadUrlAndStore(url, mime, objectKeyPrefix) {
  const storage = STORAGE();
  console.log(`⬇️  [OUTBOUND URL] url=${url} storage=${storage}`);

  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 30000,
  });

  const mimeType      = mime || response.headers['content-type']?.split(';')[0] || 'application/octet-stream';
  const contentLength = parseInt(response.headers['content-length'] || '-1');
  const fileName      = `${Date.now()}.${extFromMime(mimeType)}`;
  const folder        = objectKeyPrefix || `whatsapp/outbound/${mediaTypeFolder(mimeType)}`;
  const objectKey     = `${folder}/${fileName}`;

  let result;
  if (storage === 'minio') {
    result = await putToMinIO(response.data, mimeType, objectKey, contentLength);
  } else {
    result = await putToLocal(response.data, folder, fileName);
  }

  return { ...result, fileName, mimeType, downloadedAt: new Date() };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: OUTBOUND via file — store local temp file
// ─────────────────────────────────────────────────────────────────────────────
export async function storeLocalFile(filePath, mime) {
  const storage = STORAGE();
  console.log(`📁 [OUTBOUND FILE] filePath=${filePath} storage=${storage}`);

  const mimeType  = mime || 'application/octet-stream';
  const fileName  = `${Date.now()}-${path.basename(filePath)}`;
  const folder    = `whatsapp/outbound/${mediaTypeFolder(mimeType)}`;
  const objectKey = `${folder}/${fileName}`;
  const fileSize  = fs.statSync(filePath).size;

  let result;
  if (storage === 'minio') {
    const client = getMinioClient();
    const bucket = BUCKET();

    let exists;
    try {
      exists = await client.bucketExists(bucket);
    } catch (err) {
      throw new Error(`MinIO bucketExists() failed: ${err.message} | MINIO_INTERNAL_URL=${process.env.MINIO_INTERNAL_URL}`);
    }
    if (!exists) {
      throw new Error(`Bucket "${bucket}" not found. Create at https://play.min.io:9443`);
    }

    const stream = fs.createReadStream(filePath);
    await client.putObject(bucket, objectKey, stream, fileSize, { 'Content-Type': mimeType });

    const minioUrl = objectUrl(objectKey);
    console.log(`   ✅ MinIO stored  → ${objectKey}`);
    console.log(`   🌐 Public URL   → ${minioUrl}`);
    result = { minioKey: objectKey, minioUrl };
  } else {
    const dir       = path.join(UPLOAD_DIR(), folder);
    mkdirSync(dir, { recursive: true });
    const localPath = path.join(dir, fileName);
    fs.copyFileSync(filePath, localPath);
    console.log(`   💾 Local saved  → ${localPath}`);
    result = { localPath };
  }

  return { ...result, fileName, mimeType, fileSize, downloadedAt: new Date() };
}
