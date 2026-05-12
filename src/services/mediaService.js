/**
 * mediaService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Downloads media from WhatsApp Cloud API and stores it either:
 *   - locally  (MEDIA_STORAGE=local)  → ./uploads/<type>/<filename>
 *   - MinIO    (MEDIA_STORAGE=minio)  → minio://<bucket>/whatsapp/<type>/<filename>
 *
 * WhatsApp media download is a two-step process:
 *   1. GET  /{media-id}  →  { url, mime_type, sha256, file_size }
 *   2. GET  {url}        →  binary bytes  (Authorization header required)
 */

import axios from 'axios';
import path from 'path';
import { createWriteStream, mkdirSync } from 'fs';
import { pipeline } from 'stream/promises';
import { PassThrough } from 'stream';
import { getMinioClient, objectUrl } from '../config/minioClient.js';

const BASE_URL   = `https://graph.facebook.com/${process.env.WA_API_VERSION}`;
const TOKEN      = () => process.env.WA_ACCESS_TOKEN;
const STORAGE    = () => process.env.MEDIA_STORAGE || 'local';
const UPLOAD_DIR = () => process.env.UPLOAD_DIR    || './uploads';
const BUCKET     = () => process.env.MINIO_BUCKET  || 'whatsapp-media';

// ─── MIME → extension map ─────────────────────────────────────────────────────
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

// ─── Step 1: Resolve media URL + metadata from WhatsApp ──────────────────────
export async function resolveMediaUrl(mediaId) {
  const { data } = await axios.get(`${BASE_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN()}` },
  });
  // data = { url, mime_type, sha256, file_size, id }
  return data;
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
  return { localPath };
}

// ─── Step 2b: Save to MinIO ───────────────────────────────────────────────────
async function saveMinIO(downloadUrl, mime, fileName, fileSize) {
  const minioClient = getMinioClient();
  const folder      = mediaTypeFolder(mime);
  const objectKey   = `whatsapp/${folder}/${fileName}`;

  // Stream directly from Meta → MinIO without writing to disk
  const response = await axios.get(downloadUrl, {
    responseType: 'stream',
    headers: { Authorization: `Bearer ${TOKEN()}` },
  });

  // Content-Length from Meta's CDN (used by MinIO for progress & validation)
  const contentLength = parseInt(response.headers['content-length'] || fileSize || '-1');

  // Route through a PassThrough so Node handles back-pressure cleanly
  const pass = new PassThrough();
  response.data.pipe(pass);

  await minioClient.putObject(
    BUCKET(),
    objectKey,
    pass,
    contentLength > 0 ? contentLength : undefined,
    { 'Content-Type': mime }
  );

  const minioUrl = objectUrl(objectKey);
  console.log(`   ✅ MinIO: stored → ${objectKey}`);

  return { minioKey: objectKey, minioUrl };
}

// ─── Main: download and store media ──────────────────────────────────────────
/**
 * @param {string}  mediaId   WhatsApp media ID from webhook payload
 * @param {string}  mime      mime_type hint (overridden by Meta's response)
 * @param {string}  [hint]    optional original filename (for documents)
 * @returns {object}          storage result merged with metadata
 *
 * Returned object always includes:
 *   fileName, mimeType, sha256, fileSize, downloadedAt
 * Plus one of:
 *   localPath             (MEDIA_STORAGE=local)
 *   minioKey, minioUrl    (MEDIA_STORAGE=minio)
 */
export async function downloadAndStoreMedia(mediaId, mime, hint = null) {
  // Step 1 — resolve the actual download URL from Meta
  const meta     = await resolveMediaUrl(mediaId);
  const mimeType = meta.mime_type || mime || 'application/octet-stream';
  const ext      = extFromMime(mimeType);
  const fileName = hint || `${mediaId}.${ext}`;

  let result = {};

  if (STORAGE() === 'minio') {
    result = await saveMinIO(meta.url, mimeType, fileName, meta.file_size);
  } else {
    result = await saveLocal(meta.url, mimeType, fileName);
  }

  return {
    ...result,
    fileName,
    mimeType,
    sha256:       meta.sha256,
    fileSize:     meta.file_size,
    downloadedAt: new Date(),
  };
}
