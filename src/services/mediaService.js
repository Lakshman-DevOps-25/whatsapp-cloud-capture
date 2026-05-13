/**
 * mediaService.js
 * Handles all media storage — inbound and outbound — to MinIO or local disk.
 */

import axios            from 'axios';
import fs               from 'fs';
import path             from 'path';
import os               from 'os';
import { mkdirSync, createWriteStream } from 'fs';
import { pipeline }     from 'stream/promises';
import { PassThrough }  from 'stream';
import { getMinioClient, objectUrl } from '../config/minioClient.js';

// ── Lazy env getters ──────────────────────────────────────────────────────────
const BASE_URL   = () => `https://graph.facebook.com/${process.env.WA_API_VERSION}`;
const TOKEN      = () => process.env.WA_ACCESS_TOKEN;
const STORAGE    = () => (process.env.MEDIA_STORAGE || 'local').trim().toLowerCase();
const UPLOAD_DIR = () => process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'wa_media');
const BUCKET     = () => (process.env.MINIO_BUCKET || 'whatsapp-media').trim();

// ── Bucket existence cached — only checked ONCE per process lifetime ──────────
// play.min.io rate-limits bucketExists() — calling it on every upload causes S3Error
let _bucketVerified = false;

async function verifyBucketOnce() {
  if (_bucketVerified) return; // already verified this session

  const client = getMinioClient();
  const bucket = BUCKET();
  console.log(`   🔍 Checking MinIO bucket "${bucket}" (once per session)...`);

  let exists;
  try {
    exists = await client.bucketExists(bucket);
  } catch (err) {
    throw new Error(
      `MinIO connection failed: ${err.message}\n` +
      `  MINIO_INTERNAL_URL = ${process.env.MINIO_INTERNAL_URL || 'NOT SET'}\n` +
      `  MINIO_ACCESS_KEY   = ${process.env.MINIO_ACCESS_KEY   ? 'set' : 'NOT SET'}\n` +
      `  MINIO_BUCKET       = ${bucket}`
    );
  }

  if (!exists) {
    throw new Error(
      `MinIO bucket "${bucket}" does not exist.\n` +
      `→ Go to https://play.min.io:9443 → Buckets → Create Bucket → name: ${bucket}\n` +
      `→ Set Access Policy to "Public"`
    );
  }

  _bucketVerified = true;
  console.log(`   ✅ MinIO bucket "${bucket}" verified`);
}

// ── MIME helpers ──────────────────────────────────────────────────────────────
const MIME_EXT = {
  'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp', 'image/gif':'gif',
  'video/mp4':'mp4',  'video/3gpp':'3gp',
  'audio/ogg':'ogg',  'audio/ogg; codecs=opus':'ogg',
  'audio/mpeg':'mp3', 'audio/mp4':'m4a', 'audio/aac':'aac',
  'application/pdf':'pdf',
  'application/vnd.ms-excel':'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
  'application/msword':'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
};
export const extFromMime     = (mime) => MIME_EXT[mime] || 'bin';
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
    if (missing.length) throw new Error(`MEDIA_STORAGE=minio but missing env vars: ${missing.join(', ')}`);
    console.log(`✅ Media storage  : MinIO`);
    console.log(`   Internal URL   : ${process.env.MINIO_INTERNAL_URL}`);
    console.log(`   Public URL     : ${process.env.MINIO_PUBLIC_URL}`);
    console.log(`   Bucket         : ${process.env.MINIO_BUCKET}`);
  } else {
    console.log(`✅ Media storage  : local → ${UPLOAD_DIR()}`);
  }
}

// ── Resolve WhatsApp media download URL ──────────────────────────────────────
export async function resolveMediaUrl(mediaId) {
  const { data } = await axios.get(`${BASE_URL()}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN()}` },
    timeout: 15000,
  });
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: stream → MinIO
// ─────────────────────────────────────────────────────────────────────────────
async function putToMinIO(stream, mimeType, objectKey, contentLength) {
  await verifyBucketOnce(); // cached — only hits network once

  const client = getMinioClient();
  const bucket = BUCKET();

  console.log(`   🗄  MinIO putObject: bucket=${bucket} key=${objectKey}`);

  // PassThrough needed because MinIO SDK requires a readable stream
  // that it can control — piping directly can cause issues with some axios streams
  const pass = new PassThrough();
  stream.pipe(pass);

  await client.putObject(
    bucket,
    objectKey,
    pass,
    contentLength > 0 ? contentLength : undefined,
    { 'Content-Type': mimeType }
  );

  const minioUrl = objectUrl(objectKey);
  console.log(`   ✅ MinIO stored   : ${objectKey}`);
  console.log(`   🌐 Public URL     : ${minioUrl}`);
  return { minioKey: objectKey, minioUrl };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: stream → local disk
// ─────────────────────────────────────────────────────────────────────────────
async function putToLocal(stream, objectKey) {
  const fullPath = path.join(UPLOAD_DIR(), objectKey);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  await pipeline(stream, createWriteStream(fullPath));
  console.log(`   💾 Local saved    : ${fullPath}`);
  return { localPath: fullPath };
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE: download any URL and store it
// ─────────────────────────────────────────────────────────────────────────────
async function downloadAndStore(downloadUrl, mimeType, objectKey, axiosConfig = {}) {
  const storage = STORAGE();
  console.log(`   ⬇️  Downloading → storage=${storage} key=${objectKey}`);

  const response = await axios.get(downloadUrl, {
    responseType: 'stream',
    timeout: 60000,
    ...axiosConfig,
  });

  const contentLength = parseInt(response.headers['content-length'] || '-1');

  if (storage === 'minio') {
    return putToMinIO(response.data, mimeType, objectKey, contentLength);
  } else {
    return putToLocal(response.data, objectKey);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: INBOUND — download from WhatsApp CDN (needs auth header)
// ─────────────────────────────────────────────────────────────────────────────
export async function downloadAndStoreMedia(mediaId, mime, hint = null) {
  console.log(`\n📥 [INBOUND MEDIA] mediaId=${mediaId}`);

  const meta      = await resolveMediaUrl(mediaId);
  const mimeType  = meta.mime_type || mime || 'application/octet-stream';
  const fileName  = hint || `${mediaId}.${extFromMime(mimeType)}`;
  const objectKey = `whatsapp/inbound/${mediaTypeFolder(mimeType)}/${fileName}`;

  console.log(`   mimeType=${mimeType} objectKey=${objectKey}`);

  const result = await downloadAndStore(
    meta.url,
    mimeType,
    objectKey,
    { headers: { Authorization: `Bearer ${TOKEN()}` } }
  );

  return {
    ...result,
    fileName,
    mimeType,
    sha256:       meta.sha256,
    fileSize:     meta.file_size,
    downloadedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: OUTBOUND via URL — download public URL and store
// ─────────────────────────────────────────────────────────────────────────────
export async function downloadUrlAndStore(url, mimeType, objectKeyPrefix) {
  console.log(`\n📥 [OUTBOUND URL] url=${url}`);

  // First get content-type from headers
  const head = await axios.head(url, { timeout: 10000 }).catch(() => null);
  const mime  = mimeType || head?.headers?.['content-type']?.split(';')[0] || 'application/octet-stream';
  const fileName  = `${Date.now()}.${extFromMime(mime)}`;
  const objectKey = `${objectKeyPrefix}/${fileName}`;

  console.log(`   mimeType=${mime} objectKey=${objectKey}`);

  const result = await downloadAndStore(url, mime, objectKey);

  return { ...result, fileName, mimeType: mime, downloadedAt: new Date() };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: OUTBOUND via file — store a local temp file
// ─────────────────────────────────────────────────────────────────────────────
export async function storeLocalFile(filePath, mimeType) {
  const storage = STORAGE();
  console.log(`\n📁 [OUTBOUND FILE] filePath=${filePath} storage=${storage}`);

  const mime      = mimeType || 'application/octet-stream';
  const fileName  = `${Date.now()}-${path.basename(filePath)}`;
  const objectKey = `whatsapp/outbound/${mediaTypeFolder(mime)}/${fileName}`;
  const fileSize  = fs.statSync(filePath).size;

  console.log(`   mimeType=${mime} objectKey=${objectKey} size=${fileSize}`);

  let result;
  if (storage === 'minio') {
    await verifyBucketOnce(); // cached — only hits network once

    const client = getMinioClient();
    const bucket = BUCKET();
    const stream = fs.createReadStream(filePath);

    await client.putObject(bucket, objectKey, stream, fileSize, { 'Content-Type': mime });

    const minioUrl = objectUrl(objectKey);
    console.log(`   ✅ MinIO stored   : ${objectKey}`);
    console.log(`   🌐 Public URL     : ${minioUrl}`);
    result = { minioKey: objectKey, minioUrl };
  } else {
    const fullPath = path.join(UPLOAD_DIR(), objectKey);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.copyFileSync(filePath, fullPath);
    console.log(`   💾 Local saved    : ${fullPath}`);
    result = { localPath: fullPath };
  }

  return { ...result, fileName, mimeType: mime, fileSize, downloadedAt: new Date() };
}
