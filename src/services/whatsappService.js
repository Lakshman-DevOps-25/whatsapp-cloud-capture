/**
 * whatsappService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Helpers for SENDING messages via WhatsApp Cloud API.
 *
 * Every send function does THREE things:
 *   1. POST the message to Meta's Graph API
 *   2. Upsert the recipient contact in MongoDB
 *   3. Save the outbound message with the real Meta message ID to MongoDB
 *
 * For outbound media sent via file upload:
 *   4. Uploads the file to MinIO (copy of what was sent) and stores minioUrl
 *
 * Status updates (sent → delivered → read) arrive via webhook.js using the
 * real messageId returned here and stored in MongoDB.
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import Message from '../models/Message.js';
import Contact from '../models/Contact.js';
import { getMinioClient, objectUrl } from '../config/minioClient.js';
import { extFromMime, mediaTypeFolder } from './mediaService.js';

const BASE_URL = () =>
  `https://graph.facebook.com/${process.env.WA_API_VERSION}/${process.env.WA_PHONE_NUMBER_ID}`;

const authHeader = () => ({
  Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
});

// ─── Low-level POST to /messages ─────────────────────────────────────────────
async function postMessage(payload) {
  const { data } = await axios.post(`${BASE_URL()}/messages`, payload, {
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
  });
  return data;
}

// ─── Upsert recipient contact ─────────────────────────────────────────────────
async function upsertContact(phone) {
  try {
    await Contact.findOneAndUpdate(
      { phone },
      {
        $set:         { phone, waId: phone, lastSeen: new Date() },
        $inc:         { messageCount: 1 },
        $setOnInsert: { firstSeen: new Date() },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error('⚠️  Failed to upsert contact:', err.message);
  }
}

// ─── Save outbound message to MongoDB ────────────────────────────────────────
async function saveOutbound(to, type, messageId, fields = {}) {
  console.log("In saveOutbound function");
  try {
    const doc = {
      messageId,
      direction:   'outbound',
      from:        process.env.WA_PHONE_NUMBER_ID,
      to,
      type,
      waTimestamp: new Date(),
      status:      'sent',
    };

    if (fields.body)        doc.body        = fields.body;
    if (fields.media)       doc.media       = fields.media;
    if (fields.location)    doc.location    = fields.location;
    if (fields.buttonReply) doc.buttonReply = fields.buttonReply;
    if (fields.rawPayload)  doc.rawPayload  = fields.rawPayload;

    await Message.findOneAndUpdate(
      { messageId },
      { $set: doc },
      { upsert: true, new: true }
    );
    console.log("Saved in Message table");

    console.log(`📤 OUTBOUND ${type} → ${to} [${messageId}]`);
  } catch (err) {
    console.error('⚠️  Failed to persist outbound message:', err.message);
  }
}

// ─── Upload outbound file to MinIO (keeps a copy of every sent media) ────────
async function storeOutboundInMinIO(filePath, mimeType) {
  if (process.env.MEDIA_STORAGE !== 'minio') return {};
  try {
    const minioClient = getMinioClient();
    const bucket      = process.env.MINIO_BUCKET || 'whatsapp-media';
    const folder      = mediaTypeFolder(mimeType);
    const fileName    = `${Date.now()}-${path.basename(filePath)}`;
    const objectKey   = `whatsapp/outbound/${folder}/${fileName}`;
    const fileStream  = fs.createReadStream(filePath);
    const fileSize    = fs.statSync(filePath).size;

    await minioClient.putObject(bucket, objectKey, fileStream, fileSize, {
      'Content-Type': mimeType,
    });

    const minioUrl = objectUrl(objectKey);
    console.log(`   ✅ MinIO outbound stored → ${objectKey}`);
    return { minioKey: objectKey, minioUrl };
  } catch (err) {
    console.error('⚠️  MinIO outbound upload failed:', err.message);
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

// ─── 1. Text ──────────────────────────────────────────────────────────────────
export async function sendText(to, text, previewUrl = false) {
  const res = await postMessage({
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to,
    type: 'text',
    text: { body: text, preview_url: previewUrl },
  });
  const messageId = res.messages?.[0]?.id;
  await upsertContact(to);
  await saveOutbound(to, 'text', messageId, { body: text });
  return res;
}

// ─── 2. Image ─────────────────────────────────────────────────────────────────
// opts: { url?, mediaId?, caption?, filePath?, mimeType? }
// Use filePath to send a local file — it gets uploaded to WA CDN + copied to MinIO
export async function sendImage(to, { url, mediaId, caption = '', filePath, mimeType = 'image/jpeg' }) {
  let resolvedId = mediaId;
  let minioData  = {};

  if (filePath) {
    resolvedId = await uploadMedia(filePath, mimeType);
    minioData  = await storeOutboundInMinIO(filePath, mimeType);
  }

  const imageObj = resolvedId ? { id: resolvedId } : { link: url };
  if (caption) imageObj.caption = caption;

  const res = await postMessage({ messaging_product: 'whatsapp', to, type: 'image', image: imageObj });
  const messageId = res.messages?.[0]?.id;
  await upsertContact(to);
  await saveOutbound(to, 'image', messageId, {
    body:  caption,
    media: { mediaId: resolvedId, mimeType, caption, ...minioData },
  });
  return res;
}

// ─── 3. Video ─────────────────────────────────────────────────────────────────
export async function sendVideo(to, { url, mediaId, caption = '', filePath, mimeType = 'video/mp4' }) {
  let resolvedId = mediaId;
  let minioData  = {};

  if (filePath) {
    resolvedId = await uploadMedia(filePath, mimeType);
    minioData  = await storeOutboundInMinIO(filePath, mimeType);
  }

  const videoObj = resolvedId ? { id: resolvedId } : { link: url };
  if (caption) videoObj.caption = caption;

  const res = await postMessage({ messaging_product: 'whatsapp', to, type: 'video', video: videoObj });
  const messageId = res.messages?.[0]?.id;
  await upsertContact(to);
  await saveOutbound(to, 'video', messageId, {
    body:  caption,
    media: { mediaId: resolvedId, mimeType, caption, ...minioData },
  });
  return res;
}

// ─── 4. Audio ─────────────────────────────────────────────────────────────────
export async function sendAudio(to, { url, mediaId, filePath, mimeType = 'audio/mpeg' }) {
  let resolvedId = mediaId;
  let minioData  = {};

  if (filePath) {
    resolvedId = await uploadMedia(filePath, mimeType);
    minioData  = await storeOutboundInMinIO(filePath, mimeType);
  }

  const audioObj = resolvedId ? { id: resolvedId } : { link: url };

  const res = await postMessage({ messaging_product: 'whatsapp', to, type: 'audio', audio: audioObj });
  const messageId = res.messages?.[0]?.id;
  await upsertContact(to);
  await saveOutbound(to, 'audio', messageId, {
    media: { mediaId: resolvedId, mimeType, ...minioData },
  });
  return res;
}

// ─── 5. Document ──────────────────────────────────────────────────────────────
export async function sendDocument(to, { url, mediaId, caption = '', fileName = '', filePath, mimeType = 'application/octet-stream' }) {
  let resolvedId   = mediaId;
  let resolvedName = fileName;
  let minioData    = {};

  if (filePath) {
    resolvedId   = await uploadMedia(filePath, mimeType);
    resolvedName = resolvedName || path.basename(filePath);
    minioData    = await storeOutboundInMinIO(filePath, mimeType);
  }

  const docObj = resolvedId ? { id: resolvedId } : { link: url };
  if (caption)      docObj.caption  = caption;
  if (resolvedName) docObj.filename = resolvedName;

  const res = await postMessage({ messaging_product: 'whatsapp', to, type: 'document', document: docObj });
  const messageId = res.messages?.[0]?.id;
  await upsertContact(to);
  await saveOutbound(to, 'document', messageId, {
    body:  caption,
    media: { mediaId: resolvedId, mimeType, fileName: resolvedName, caption, ...minioData },
  });
  return res;
}

// ─── 6. Sticker ───────────────────────────────────────────────────────────────
export async function sendSticker(to, { url, mediaId }) {
  const stickerObj = mediaId ? { id: mediaId } : { link: url };
  const res = await postMessage({ messaging_product: 'whatsapp', to, type: 'sticker', sticker: stickerObj });
  const messageId = res.messages?.[0]?.id;
  await upsertContact(to);
  await saveOutbound(to, 'sticker', messageId, {
    media: { mediaId, mimeType: 'image/webp' },
  });
  return res;
}

// ─── 7. Location ──────────────────────────────────────────────────────────────
export async function sendLocation(to, { latitude, longitude, name = '', address = '' }) {
  const res = await postMessage({
    messaging_product: 'whatsapp',
    to,
    type:     'location',
    location: { latitude, longitude, name, address },
  });
  const messageId = res.messages?.[0]?.id;
  await upsertContact(to);
  await saveOutbound(to, 'location', messageId, {
    location: { latitude, longitude, name, address },
  });
  return res;
}

// ─── 8. Template ──────────────────────────────────────────────────────────────
/**
 * components example:
 * [
 *   { type: 'header', parameters: [{ type: 'image', image: { link: 'https://...' } }] },
 *   { type: 'body',   parameters: [{ type: 'text', text: 'John' }] },
 *   { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'ABC123' }] }
 * ]
 */
export async function sendTemplate(to, templateName, languageCode = 'en_US', components = []) {
  const res = await postMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name: templateName, language: { code: languageCode }, components },
  });
  const messageId = res.messages?.[0]?.id;
  await upsertContact(to);
  await saveOutbound(to, 'template', messageId, {
    body:       `[template: ${templateName}]`,
    rawPayload: { templateName, languageCode, components },
  });
  return res;
}

// ─── 9. Interactive buttons (up to 3) ─────────────────────────────────────────
export async function sendButtons(to, bodyText, buttons, headerText = '', footerText = '') {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type:   'button',
      body:   { text: bodyText },
      action: {
        buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
      },
    },
  };
  if (headerText) payload.interactive.header = { type: 'text', text: headerText };
  if (footerText) payload.interactive.footer = { text: footerText };

  const res = await postMessage(payload);
  const messageId = res.messages?.[0]?.id;
  await upsertContact(to);
  await saveOutbound(to, 'interactive', messageId, {
    body:       bodyText,
    rawPayload: { type: 'button', headerText, bodyText, footerText, buttons },
  });
  return res;
}

// ─── 10. Interactive list ─────────────────────────────────────────────────────
export async function sendList(to, bodyText, buttonLabel, sections) {
  const res = await postMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type:   'list',
      body:   { text: bodyText },
      action: { button: buttonLabel, sections },
    },
  });
  const messageId = res.messages?.[0]?.id;
  await upsertContact(to);
  await saveOutbound(to, 'interactive', messageId, {
    body:       bodyText,
    rawPayload: { type: 'list', bodyText, buttonLabel, sections },
  });
  return res;
}

// ─── 11. Mark read (blue ticks) ───────────────────────────────────────────────
export async function markRead(messageId) {
  await axios.post(
    `${BASE_URL()}/messages`,
    { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
    { headers: { ...authHeader(), 'Content-Type': 'application/json' } }
  );
  await Message.findOneAndUpdate({ messageId }, { $set: { status: 'read' } });
}

// ─── 12. Upload file to WhatsApp CDN → reusable media ID ─────────────────────
export async function uploadMedia(filePath, mimeType) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', fs.createReadStream(filePath), {
    contentType: mimeType,
    filename:    path.basename(filePath),
  });
  const { data } = await axios.post(
    `${BASE_URL()}/media`,
    form,
    { headers: { ...authHeader(), ...form.getHeaders() } }
  );
  return data.id;
}
