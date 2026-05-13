/**
 * whatsappService.js — OUTBOUND: business → customer
 *
 * KEY DESIGN: Save to MongoDB FIRST (status=queued), then send to Meta.
 * This guarantees the record exists before any status webhook arrives.
 * After Meta responds, update with the real messageId and status=sent.
 */

import axios    from 'axios';
import fs       from 'fs';
import path     from 'path';
import FormData from 'form-data';
import Message  from '../models/Message.js';
import Contact  from '../models/Contact.js';
import { mediaTypeFolder, downloadUrlAndStore, storeLocalFile } from './mediaService.js';

const BASE_URL   = () => `https://graph.facebook.com/${process.env.WA_API_VERSION}/${process.env.WA_PHONE_NUMBER_ID}`;
const MY_PHONE   = () => (process.env.WA_BUSINESS_PHONE || process.env.WA_PHONE_NUMBER_ID || '').trim();
const authHeader = () => ({ Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` });

// ─── POST to Meta ─────────────────────────────────────────────────────────────
async function postMessage(payload) {
  const { data } = await axios.post(`${BASE_URL()}/messages`, payload, {
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  console.log(`   📡 Meta response: ${JSON.stringify(data)}`);
  return data;
}

// ─── Upsert contact ───────────────────────────────────────────────────────────
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
    console.error(`   ⚠️  upsertContact(${phone}): ${err.message}`);
  }
}

// ─── Core send helper ─────────────────────────────────────────────────────────
// Saves to DB FIRST with a temp ID, sends to Meta, then updates with real messageId.
// This ensures the record always exists when status webhooks arrive.
async function sendAndSave(to, type, metaPayload, extraFields = {}) {
  const toPhone  = (to || '').toString().trim();
  const fromPhone = MY_PHONE();

  if (!toPhone)   throw new Error(`to is required`);
  if (!fromPhone) throw new Error(`WA_BUSINESS_PHONE env var is not set`);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📤 ${type.toUpperCase()} → from=${fromPhone} to=${toPhone}`);

  // ── Step 1: Save to DB with temp ID BEFORE sending ────────────────────────
  // This guarantees the record exists before Meta's status webhook fires.
  const tempId = `pending_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const doc = {
    messageId:   tempId,
    direction:   'outbound',
    from:        fromPhone,
    to:          toPhone,
    type,
    waTimestamp: new Date(),
    status:      'queued',
  };
  if (extraFields.body)       doc.body       = extraFields.body;
  if (extraFields.media)      doc.media      = extraFields.media;
  if (extraFields.location)   doc.location   = extraFields.location;
  if (extraFields.rawPayload) doc.rawPayload = extraFields.rawPayload;

  let dbRecord;
  try {
    dbRecord = await Message.create(doc);
    console.log(`   💾 Pre-saved to DB: _id=${dbRecord._id} status=queued`);
  } catch (dbErr) {
    console.error(`   ❌ Pre-save FAILED: ${dbErr.message}`);
    throw new Error(`DB pre-save failed: ${dbErr.message}`);
  }

  // ── Step 2: Send to Meta ──────────────────────────────────────────────────
  let metaRes;
  try {
    metaRes = await postMessage(metaPayload);
  } catch (metaErr) {
    // Meta send failed — mark DB record as failed
    await Message.findByIdAndUpdate(dbRecord._id, { $set: { status: 'failed', errorMessage: metaErr.message } });
    console.error(`   ❌ Meta send FAILED: ${metaErr.message}`);
    throw metaErr;
  }

  // ── Step 3: Update DB record with real messageId from Meta ────────────────
  const realMessageId = metaRes?.messages?.[0]?.id;
  if (!realMessageId) {
    await Message.findByIdAndUpdate(dbRecord._id, { $set: { status: 'failed', errorMessage: 'No messageId in Meta response' } });
    throw new Error(`Meta returned no messageId: ${JSON.stringify(metaRes)}`);
  }

  await Message.findByIdAndUpdate(dbRecord._id, {
    $set: { messageId: realMessageId, status: 'sent' },
  });
  console.log(`   ✅ DB updated: messageId=${realMessageId} status=sent`);

  // ── Step 4: Upsert contact ────────────────────────────────────────────────
  await upsertContact(toPhone);

  return metaRes;
}

// ─── Store outbound media to MinIO/local ─────────────────────────────────────
async function storeMedia(opts, mimeType) {
  if (opts.filePath) {
    return await storeLocalFile(opts.filePath, mimeType);
  }
  if (opts.url) {
    const prefix = `whatsapp/outbound/${mediaTypeFolder(mimeType)}`;
    return await downloadUrlAndStore(opts.url, mimeType, prefix);
  }
  return {};
}

// ─── Upload to WhatsApp CDN ───────────────────────────────────────────────────
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

export async function sendText(to, text, previewUrl = false) {
  return sendAndSave(
    to, 'text',
    { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text, preview_url: previewUrl } },
    { body: text }
  );
}

export async function sendImage(to, { url, mediaId, caption = '', filePath, mimeType = 'image/jpeg' }) {
  // Store media copy first
  let stored = {};
  try { stored = await storeMedia({ filePath, url }, mimeType); }
  catch (e) { console.error(`   ⚠️  storeMedia failed: ${e.message}`); }

  // Upload to WA CDN if file
  let resolvedId = mediaId;
  if (filePath) resolvedId = await uploadMedia(filePath, mimeType);
  if (!resolvedId && !url) throw new Error('sendImage: provide url, mediaId, or filePath');

  const imageObj = resolvedId ? { id: resolvedId } : { link: url };
  if (caption) imageObj.caption = caption;

  return sendAndSave(
    to, 'image',
    { messaging_product: 'whatsapp', to, type: 'image', image: imageObj },
    { body: caption, media: { mediaId: resolvedId, mimeType, caption, ...stored } }
  );
}

export async function sendVideo(to, { url, mediaId, caption = '', filePath, mimeType = 'video/mp4' }) {
  let stored = {};
  try { stored = await storeMedia({ filePath, url }, mimeType); }
  catch (e) { console.error(`   ⚠️  storeMedia failed: ${e.message}`); }

  let resolvedId = mediaId;
  if (filePath) resolvedId = await uploadMedia(filePath, mimeType);
  if (!resolvedId && !url) throw new Error('sendVideo: provide url, mediaId, or filePath');

  const videoObj = resolvedId ? { id: resolvedId } : { link: url };
  if (caption) videoObj.caption = caption;

  return sendAndSave(
    to, 'video',
    { messaging_product: 'whatsapp', to, type: 'video', video: videoObj },
    { body: caption, media: { mediaId: resolvedId, mimeType, caption, ...stored } }
  );
}

export async function sendAudio(to, { url, mediaId, filePath, mimeType = 'audio/mpeg' }) {
  let stored = {};
  try { stored = await storeMedia({ filePath, url }, mimeType); }
  catch (e) { console.error(`   ⚠️  storeMedia failed: ${e.message}`); }

  let resolvedId = mediaId;
  if (filePath) resolvedId = await uploadMedia(filePath, mimeType);
  if (!resolvedId && !url) throw new Error('sendAudio: provide url, mediaId, or filePath');

  const audioObj = resolvedId ? { id: resolvedId } : { link: url };

  return sendAndSave(
    to, 'audio',
    { messaging_product: 'whatsapp', to, type: 'audio', audio: audioObj },
    { media: { mediaId: resolvedId, mimeType, ...stored } }
  );
}

export async function sendDocument(to, { url, mediaId, caption = '', fileName = '', filePath, mimeType = 'application/octet-stream' }) {
  let stored = {};
  try { stored = await storeMedia({ filePath, url }, mimeType); }
  catch (e) { console.error(`   ⚠️  storeMedia failed: ${e.message}`); }

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

  return sendAndSave(
    to, 'document',
    { messaging_product: 'whatsapp', to, type: 'document', document: docObj },
    { body: caption, media: { mediaId: resolvedId, mimeType, fileName: resolvedName, caption, ...stored } }
  );
}

export async function sendSticker(to, { url, mediaId }) {
  const obj = mediaId ? { id: mediaId } : { link: url };
  return sendAndSave(
    to, 'sticker',
    { messaging_product: 'whatsapp', to, type: 'sticker', sticker: obj },
    { media: { mediaId, mimeType: 'image/webp' } }
  );
}

export async function sendLocation(to, { latitude, longitude, name = '', address = '' }) {
  return sendAndSave(
    to, 'location',
    { messaging_product: 'whatsapp', to, type: 'location', location: { latitude, longitude, name, address } },
    { location: { latitude, longitude, name, address } }
  );
}

export async function sendTemplate(to, templateName, languageCode = 'en_US', components = []) {
  return sendAndSave(
    to, 'template',
    { messaging_product: 'whatsapp', to, type: 'template', template: { name: templateName, language: { code: languageCode }, components } },
    { body: `[template:${templateName}]`, rawPayload: { templateName, languageCode, components } }
  );
}

export async function sendButtons(to, bodyText, buttons, headerText = '', footerText = '') {
  const interactive = {
    type:   'button',
    body:   { text: bodyText },
    action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
  };
  if (headerText) interactive.header = { type: 'text', text: headerText };
  if (footerText) interactive.footer = { text: footerText };

  return sendAndSave(
    to, 'interactive',
    { messaging_product: 'whatsapp', to, type: 'interactive', interactive },
    { body: bodyText, rawPayload: { type: 'button', headerText, bodyText, footerText, buttons } }
  );
}

export async function sendList(to, bodyText, buttonLabel, sections) {
  return sendAndSave(
    to, 'interactive',
    { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'list', body: { text: bodyText }, action: { button: buttonLabel, sections } } },
    { body: bodyText, rawPayload: { type: 'list', bodyText, buttonLabel, sections } }
  );
}

export async function markRead(messageId) {
  try {
    await axios.post(
      `${BASE_URL()}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: { ...authHeader(), 'Content-Type': 'application/json' } }
    );
    await Message.findOneAndUpdate({ messageId }, { $set: { status: 'read' } });
  } catch (err) {
    console.error(`⚠️  markRead(${messageId}): ${err.message}`);
  }
}
