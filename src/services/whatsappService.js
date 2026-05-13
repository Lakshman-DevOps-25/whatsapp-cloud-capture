/**
 * whatsappService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * OUTBOUND messages: business → customer
 *
 * Every send function:
 *   1. If filePath provided  → storeLocalFile()     → MinIO/local (permanent copy)
 *   2. If URL provided       → downloadUrlAndStore() → MinIO/local (permanent copy)
 *   3. Uploads to WhatsApp CDN (get mediaId)
 *   4. POSTs to Meta Graph API (delivers to customer)
 *   5. upsertContact() → MongoDB contacts
 *   6. saveOutbound()  → MongoDB messages
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import Message from '../models/Message.js';
import Contact from '../models/Contact.js';
import { mediaTypeFolder, downloadUrlAndStore, storeLocalFile } from './mediaService.js';

const BASE_URL = () =>
  `https://graph.facebook.com/${process.env.WA_API_VERSION}/${process.env.WA_PHONE_NUMBER_ID}`;

const authHeader = () => ({ Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` });

// ─── Low-level POST to Meta /messages ────────────────────────────────────────
async function postMessage(payload) {
  const { data } = await axios.post(`${BASE_URL()}/messages`, payload, {
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return data;
}

// ─── Extract messageId — throw immediately if missing ────────────────────────
function extractMessageId(res, type) {
  const messageId = res?.messages?.[0]?.id;
  if (!messageId) throw new Error(`Meta API no messageId for ${type}: ${JSON.stringify(res)}`);
  return messageId;
}

// ─── Upsert contact ───────────────────────────────────────────────────────────
async function upsertContact(phone) {
  try {
    await Contact.findOneAndUpdate(
      { phone },
      { $set: { phone, waId: phone, lastSeen: new Date() }, $inc: { messageCount: 1 }, $setOnInsert: { firstSeen: new Date() } },
      { upsert: true, new: true }
    );
    console.log(`👤 Contact upserted: ${phone}`);
  } catch (err) {
    console.error(`⚠️  upsertContact(${phone}):`, err.message);
  }
}

// ─── Save outbound to MongoDB ─────────────────────────────────────────────────
async function saveOutbound(to, type, messageId, fields = {}) {
  if (!messageId) throw new Error(`saveOutbound: no messageId (type=${type} to=${to})`);
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

  const saved = await Message.findOneAndUpdate(
    { messageId },
    { $set: doc },
    { upsert: true, new: true }
  );
    console.log(`✅ DB saved outbound ${type} → ${to} [${messageId}] _id=${saved._id}`);
    
    console.log("Saved in Message table");

    console.log(`📤 OUTBOUND ${type} → ${to} [${messageId}]`);
    
    return saved;
  } catch (err) {
    console.error('⚠️  Failed to persist outbound message:', err.message);
  }
}

// ─── Store outbound media to MinIO/local ─────────────────────────────────────
// Works for BOTH file uploads and URL-based sends.
// Returns { minioKey, minioUrl } or { localPath } depending on MEDIA_STORAGE.
async function storeOutboundMedia(opts, mimeType, label) {
  try {
    if (opts.filePath) {
      // Sent via file upload
      return await storeLocalFile(opts.filePath, mimeType);
    } else if (opts.url) {
      // Sent via public URL — download it and store a copy
      const folder = `whatsapp/outbound/${mediaTypeFolder(mimeType)}`;
      return await downloadUrlAndStore(opts.url, mimeType, folder, null);
    }
  } catch (err) {
    // Non-fatal: message still gets delivered and saved to MongoDB
    // MinIO/local copy just won't be available
    console.error(`   ⚠️  Media store failed for ${label} (non-fatal):`, err.message);
  }
  return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD to WhatsApp CDN (for file-based sends)
// ─────────────────────────────────────────────────────────────────────────────
export async function uploadMedia(filePath, mimeType) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', fs.createReadStream(filePath), {
    contentType: mimeType,
    filename:    path.basename(filePath),
  });
  const { data } = await axios.post(`${BASE_URL()}/media`, form, {
    headers: { ...authHeader(), ...form.getHeaders() },
    timeout: 30000,
  });
  console.log(`   ☁️  WA CDN mediaId: ${data.id}`);
  return data.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

// ─── 1. Text ──────────────────────────────────────────────────────────────────
export async function sendText(to, text, previewUrl = false) {
  try {
    console.log(`📤 sendText → ${to}`);
    const res       = await postMessage({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text, preview_url: previewUrl } });
    const messageId = extractMessageId(res, 'text');
    await upsertContact(to);
    await saveOutbound(to, 'text', messageId, { body: text });
    return res;
  } catch (err) {
    console.error(`❌ sendText(${to}):`, err.message);
    throw err;
  }
}

// ─── 2. Image ─────────────────────────────────────────────────────────────────
// opts: { url?, mediaId?, caption?, filePath?, mimeType? }
export async function sendImage(to, { url, mediaId, caption = '', filePath, mimeType = 'image/jpeg' }) {
  try {
    console.log(`📤 sendImage → ${to}  [${filePath ? 'file' : url ? 'url' : 'mediaId'}]`);

    // 1. Store copy in MinIO/local
    const stored = await storeOutboundMedia({ filePath, url }, mimeType, 'image');

    // 2. Get WhatsApp mediaId
    let resolvedId = mediaId;
    if (filePath)  resolvedId = await uploadMedia(filePath, mimeType);
    if (!resolvedId && !url) throw new Error('sendImage: provide url, mediaId, or filePath');

    // 3. Send via Meta API
    const imageObj = resolvedId ? { id: resolvedId } : { link: url };
    if (caption) imageObj.caption = caption;
    const res       = await postMessage({ messaging_product: 'whatsapp', to, type: 'image', image: imageObj });
    const messageId = extractMessageId(res, 'image');

    // 4. Save to MongoDB
    await upsertContact(to);
    await saveOutbound(to, 'image', messageId, {
      body:  caption,
      media: { mediaId: resolvedId, mimeType, caption, ...stored },
    });
    return res;
  } catch (err) {
    console.error(`❌ sendImage(${to}):`, err.message);
    throw err;
  }
}

// ─── 3. Video ─────────────────────────────────────────────────────────────────
export async function sendVideo(to, { url, mediaId, caption = '', filePath, mimeType = 'video/mp4' }) {
  try {
    console.log(`📤 sendVideo → ${to}  [${filePath ? 'file' : url ? 'url' : 'mediaId'}]`);

    const stored = await storeOutboundMedia({ filePath, url }, mimeType, 'video');

    let resolvedId = mediaId;
    if (filePath) resolvedId = await uploadMedia(filePath, mimeType);
    if (!resolvedId && !url) throw new Error('sendVideo: provide url, mediaId, or filePath');

    const videoObj = resolvedId ? { id: resolvedId } : { link: url };
    if (caption) videoObj.caption = caption;
    const res       = await postMessage({ messaging_product: 'whatsapp', to, type: 'video', video: videoObj });
    const messageId = extractMessageId(res, 'video');

    await upsertContact(to);
    await saveOutbound(to, 'video', messageId, {
      body:  caption,
      media: { mediaId: resolvedId, mimeType, caption, ...stored },
    });
    return res;
  } catch (err) {
    console.error(`❌ sendVideo(${to}):`, err.message);
    throw err;
  }
}

// ─── 4. Audio ─────────────────────────────────────────────────────────────────
export async function sendAudio(to, { url, mediaId, filePath, mimeType = 'audio/mpeg' }) {
  try {
    console.log(`📤 sendAudio → ${to}  [${filePath ? 'file' : url ? 'url' : 'mediaId'}]`);

    const stored = await storeOutboundMedia({ filePath, url }, mimeType, 'audio');

    let resolvedId = mediaId;
    if (filePath) resolvedId = await uploadMedia(filePath, mimeType);
    if (!resolvedId && !url) throw new Error('sendAudio: provide url, mediaId, or filePath');

    const audioObj = resolvedId ? { id: resolvedId } : { link: url };
    const res       = await postMessage({ messaging_product: 'whatsapp', to, type: 'audio', audio: audioObj });
    const messageId = extractMessageId(res, 'audio');

    await upsertContact(to);
    await saveOutbound(to, 'audio', messageId, {
      media: { mediaId: resolvedId, mimeType, ...stored },
    });
    return res;
  } catch (err) {
    console.error(`❌ sendAudio(${to}):`, err.message);
    throw err;
  }
}

// ─── 5. Document ──────────────────────────────────────────────────────────────
export async function sendDocument(to, { url, mediaId, caption = '', fileName = '', filePath, mimeType = 'application/octet-stream' }) {
  try {
    console.log(`📤 sendDocument → ${to}  [${filePath ? 'file' : url ? 'url' : 'mediaId'}]`);

    const stored = await storeOutboundMedia({ filePath, url }, mimeType, 'document');

    let resolvedId   = mediaId;
    let resolvedName = fileName;
    if (filePath) {
      resolvedId   = await uploadMedia(filePath, mimeType);
      resolvedName = resolvedName || path.basename(filePath);
    }
    if (!resolvedId && !url) throw new Error('sendDocument: provide url, mediaId, or filePath');

    const docObj = resolvedId ? { id: resolvedId } : { link: url };
    if (caption)      docObj.caption  = caption;
    if (resolvedName) docObj.filename = resolvedName;

    const res       = await postMessage({ messaging_product: 'whatsapp', to, type: 'document', document: docObj });
    const messageId = extractMessageId(res, 'document');

    await upsertContact(to);
    await saveOutbound(to, 'document', messageId, {
      body:  caption,
      media: { mediaId: resolvedId, mimeType, fileName: resolvedName, caption, ...stored },
    });
    return res;
  } catch (err) {
    console.error(`❌ sendDocument(${to}):`, err.message);
    throw err;
  }
}

// ─── 6. Sticker ───────────────────────────────────────────────────────────────
export async function sendSticker(to, { url, mediaId }) {
  try {
    console.log(`📤 sendSticker → ${to}`);
    const stickerObj = mediaId ? { id: mediaId } : { link: url };
    const res        = await postMessage({ messaging_product: 'whatsapp', to, type: 'sticker', sticker: stickerObj });
    const messageId  = extractMessageId(res, 'sticker');
    await upsertContact(to);
    await saveOutbound(to, 'sticker', messageId, { media: { mediaId, mimeType: 'image/webp' } });
    return res;
  } catch (err) {
    console.error(`❌ sendSticker(${to}):`, err.message);
    throw err;
  }
}

// ─── 7. Location ──────────────────────────────────────────────────────────────
export async function sendLocation(to, { latitude, longitude, name = '', address = '' }) {
  try {
    console.log(`📤 sendLocation → ${to}`);
    const res       = await postMessage({ messaging_product: 'whatsapp', to, type: 'location', location: { latitude, longitude, name, address } });
    const messageId = extractMessageId(res, 'location');
    await upsertContact(to);
    await saveOutbound(to, 'location', messageId, { location: { latitude, longitude, name, address } });
    return res;
  } catch (err) {
    console.error(`❌ sendLocation(${to}):`, err.message);
    throw err;
  }
}

// ─── 8. Template ──────────────────────────────────────────────────────────────
export async function sendTemplate(to, templateName, languageCode = 'en_US', components = []) {
  try {
    console.log(`📤 sendTemplate "${templateName}" → ${to}`);
    const res       = await postMessage({ messaging_product: 'whatsapp', to, type: 'template', template: { name: templateName, language: { code: languageCode }, components } });
    const messageId = extractMessageId(res, 'template');
    await upsertContact(to);
    await saveOutbound(to, 'template', messageId, { body: `[template: ${templateName}]`, rawPayload: { templateName, languageCode, components } });
    return res;
  } catch (err) {
    console.error(`❌ sendTemplate(${to}):`, err.message);
    throw err;
  }
}

// ─── 9. Buttons ───────────────────────────────────────────────────────────────
export async function sendButtons(to, bodyText, buttons, headerText = '', footerText = '') {
  try {
    console.log(`📤 sendButtons → ${to}`);
    const payload = {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: { type: 'button', body: { text: bodyText }, action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } },
    };
    if (headerText) payload.interactive.header = { type: 'text', text: headerText };
    if (footerText) payload.interactive.footer = { text: footerText };
    const res       = await postMessage(payload);
    const messageId = extractMessageId(res, 'buttons');
    await upsertContact(to);
    await saveOutbound(to, 'interactive', messageId, { body: bodyText, rawPayload: { type: 'button', headerText, bodyText, footerText, buttons } });
    return res;
  } catch (err) {
    console.error(`❌ sendButtons(${to}):`, err.message);
    throw err;
  }
}

// ─── 10. List ─────────────────────────────────────────────────────────────────
export async function sendList(to, bodyText, buttonLabel, sections) {
  try {
    console.log(`📤 sendList → ${to}`);
    const res       = await postMessage({ messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'list', body: { text: bodyText }, action: { button: buttonLabel, sections } } });
    const messageId = extractMessageId(res, 'list');
    await upsertContact(to);
    await saveOutbound(to, 'interactive', messageId, { body: bodyText, rawPayload: { type: 'list', bodyText, buttonLabel, sections } });
    return res;
  } catch (err) {
    console.error(`❌ sendList(${to}):`, err.message);
    throw err;
  }
}

// ─── 11. Mark read ────────────────────────────────────────────────────────────
export async function markRead(messageId) {
  try {
    await axios.post(`${BASE_URL()}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: messageId }, { headers: { ...authHeader(), 'Content-Type': 'application/json' } });
    await Message.findOneAndUpdate({ messageId }, { $set: { status: 'read' } });
  } catch (err) {
    console.error(`⚠️  markRead(${messageId}):`, err.message);
  }
}
