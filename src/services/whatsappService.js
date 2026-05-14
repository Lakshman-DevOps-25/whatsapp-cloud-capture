import axios    from 'axios';
import fs       from 'fs';
import path     from 'path';
import FormData from 'form-data';
import Message  from '../models/Message.js';
import Contact  from '../models/Contact.js';
import { mediaTypeFolder, downloadUrlAndStore, storeLocalFile } from './mediaService.js';

const BASE_URL   = () => `https://graph.facebook.com/${process.env.WA_API_VERSION}/${process.env.WA_PHONE_NUMBER_ID}`;
const MY_PHONE   = () => (process.env.WA_BUSINESS_PHONE || '').trim();
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
      { $set: { phone, waId: phone, lastSeen: new Date() }, $inc: { messageCount: 1 }, $setOnInsert: { firstSeen: new Date() } },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error(`   ⚠️  upsertContact(${phone}): ${err.message}`);
  }
}

// ─── Save outbound message to MongoDB ────────────────────────────────────────
// Uses raw MongoDB driver (Message.collection) to avoid Mongoose 'type' keyword conflict.
async function saveToDb(messageId, direction, fromPhone, toPhone, msgType, status, extraFields) {
  const now = new Date();

  // Build raw document — no Mongoose schema processing
  const rawDoc = {
    messageId,
    direction,
    from:        fromPhone,
    to:          toPhone,
    type:        msgType,   // 'text', 'image', 'video', etc. — stored directly
    status,
    waTimestamp: now,
    createdAt:   now,
    updatedAt:   now,
  };

  // Add optional fields only if they have values
  if (extraFields.body)       rawDoc.body       = extraFields.body;
  if (extraFields.media)      rawDoc.media      = extraFields.media;
  if (extraFields.location)   rawDoc.location   = extraFields.location;
  if (extraFields.rawPayload) rawDoc.rawPayload = extraFields.rawPayload;

  console.log(`   💾 Saving: messageId=${messageId} type=${msgType} direction=${direction} from=${fromPhone} to=${toPhone}`);

  // Use raw collection — no Mongoose validation/casting that drops 'type'
  await Message.collection.updateOne(
    { messageId },
    { $set: rawDoc, $setOnInsert: { _id: new (await import('mongoose')).default.Types.ObjectId() } },
    { upsert: true }
  );

  console.log(`   ✅ DB saved: type=${msgType} from=${fromPhone} to=${toPhone} status=${status}`);
}

// ─── Core: send to Meta + save to MongoDB ────────────────────────────────────
async function sendAndSave(to, msgType, metaPayload, extraFields = {}) {
  const toPhone   = (to || '').toString().trim();
  const fromPhone = MY_PHONE();

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📤 OUTBOUND ${msgType} | from=${fromPhone} | to=${toPhone}`);

  if (!toPhone)   throw new Error(`"to" is required`);
  if (!fromPhone) console.warn(`   ⚠️  WA_BUSINESS_PHONE not set in env vars!`);

  // Step 1: Send to Meta API
  console.log(`   [1] Sending to Meta...`);
  const metaRes       = await postMessage(metaPayload);
  const realMessageId = metaRes?.messages?.[0]?.id;
  if (!realMessageId) throw new Error(`Meta returned no messageId: ${JSON.stringify(metaRes)}`);
  console.log(`   [2] Got messageId: ${realMessageId}`);

  // Step 2: Save to MongoDB
  console.log(`   [3] Saving to MongoDB...`);
  await saveToDb(realMessageId, 'outbound', fromPhone, toPhone, msgType, 'sent', extraFields);
  console.log(`   [4] MongoDB save complete`);

  // Step 3: Upsert contact
  await upsertContact(toPhone);
  console.log(`   [5] Contact upserted`);

  return { metaRes, realMessageId };
}

// ─── Store media and update DB record ────────────────────────────────────────
async function storeMediaAndUpdate(messageId, opts, mimeType) {
  try {
    let stored = {};
    if (opts.filePath) {
      stored = await storeLocalFile(opts.filePath, mimeType);
    } else if (opts.url) {
      const prefix = `whatsapp/outbound/${mediaTypeFolder(mimeType)}`;
      stored = await downloadUrlAndStore(opts.url, mimeType, prefix);
    }

    if (stored.minioUrl || stored.localPath) {
      const update = {};
      if (stored.minioKey)     update['media.minioKey']     = stored.minioKey;
      if (stored.minioUrl)     update['media.minioUrl']     = stored.minioUrl;
      if (stored.localPath)    update['media.localPath']    = stored.localPath;
      if (stored.fileSize)     update['media.fileSize']     = stored.fileSize;
      if (stored.downloadedAt) update['media.downloadedAt'] = stored.downloadedAt;
      await Message.collection.updateOne({ messageId }, { $set: update });
      console.log(`   ✅ Media stored: ${stored.minioUrl || stored.localPath}`);
    }
  } catch (err) {
    console.error(`   ❌ Media store FAILED for ${messageId}: ${err.message}`);
  }
}

// ─── Upload file to WhatsApp CDN ──────────────────────────────────────────────
export async function uploadMedia(filePath, mimeType) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', fs.createReadStream(filePath), { contentType: mimeType, filename: path.basename(filePath) });
  const { data } = await axios.post(`${BASE_URL()}/media`, form, {
    headers: { ...authHeader(), ...form.getHeaders() }, timeout: 30000,
  });
  console.log(`   ☁️  WA CDN mediaId: ${data.id}`);
  return data.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

export async function sendText(to, text, previewUrl = false) {
  const { metaRes } = await sendAndSave(
    to, 'text',
    { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text, preview_url: previewUrl } },
    { body: text }
  );
  return metaRes;
}

export async function sendImage(to, { url, mediaId, caption = '', filePath, mimeType = 'image/jpeg' }) {
  let resolvedId = mediaId;
  if (filePath) resolvedId = await uploadMedia(filePath, mimeType);
  if (!resolvedId && !url) throw new Error('sendImage: provide url, mediaId, or filePath');
  const imageObj = resolvedId ? { id: resolvedId } : { link: url };
  if (caption) imageObj.caption = caption;
  const { metaRes, realMessageId } = await sendAndSave(
    to, 'image',
    { messaging_product: 'whatsapp', to, type: 'image', image: imageObj },
    { body: caption, media: { mediaId: resolvedId, mimeType, caption } }
  );
  storeMediaAndUpdate(realMessageId, { filePath, url }, mimeType);
  return metaRes;
}

export async function sendVideo(to, { url, mediaId, caption = '', filePath, mimeType = 'video/mp4' }) {
  let resolvedId = mediaId;
  if (filePath) resolvedId = await uploadMedia(filePath, mimeType);
  if (!resolvedId && !url) throw new Error('sendVideo: provide url, mediaId, or filePath');
  const videoObj = resolvedId ? { id: resolvedId } : { link: url };
  if (caption) videoObj.caption = caption;
  const { metaRes, realMessageId } = await sendAndSave(
    to, 'video',
    { messaging_product: 'whatsapp', to, type: 'video', video: videoObj },
    { body: caption, media: { mediaId: resolvedId, mimeType, caption } }
  );
  storeMediaAndUpdate(realMessageId, { filePath, url }, mimeType);
  return metaRes;
}

export async function sendAudio(to, { url, mediaId, filePath, mimeType = 'audio/mpeg' }) {
  let resolvedId = mediaId;
  if (filePath) resolvedId = await uploadMedia(filePath, mimeType);
  if (!resolvedId && !url) throw new Error('sendAudio: provide url, mediaId, or filePath');
  const audioObj = resolvedId ? { id: resolvedId } : { link: url };
  const { metaRes, realMessageId } = await sendAndSave(
    to, 'audio',
    { messaging_product: 'whatsapp', to, type: 'audio', audio: audioObj },
    { media: { mediaId: resolvedId, mimeType } }
  );
  storeMediaAndUpdate(realMessageId, { filePath, url }, mimeType);
  return metaRes;
}

export async function sendDocument(to, { url, mediaId, caption = '', fileName = '', filePath, mimeType = 'application/octet-stream' }) {
  let resolvedId = mediaId, resolvedName = fileName;
  if (filePath) { resolvedId = await uploadMedia(filePath, mimeType); resolvedName = resolvedName || path.basename(filePath); }
  if (!resolvedId && !url) throw new Error('sendDocument: provide url, mediaId, or filePath');
  const docObj = resolvedId ? { id: resolvedId } : { link: url };
  if (caption)      docObj.caption  = caption;
  if (resolvedName) docObj.filename = resolvedName;
  const { metaRes, realMessageId } = await sendAndSave(
    to, 'document',
    { messaging_product: 'whatsapp', to, type: 'document', document: docObj },
    { body: caption, media: { mediaId: resolvedId, mimeType, fileName: resolvedName, caption } }
  );
  storeMediaAndUpdate(realMessageId, { filePath, url }, mimeType);
  return metaRes;
}

export async function sendSticker(to, { url, mediaId }) {
  const obj = mediaId ? { id: mediaId } : { link: url };
  const { metaRes } = await sendAndSave(
    to, 'sticker',
    { messaging_product: 'whatsapp', to, type: 'sticker', sticker: obj },
    { media: { mediaId, mimeType: 'image/webp' } }
  );
  return metaRes;
}

export async function sendLocation(to, { latitude, longitude, name = '', address = '' }) {
  const { metaRes } = await sendAndSave(
    to, 'location',
    { messaging_product: 'whatsapp', to, type: 'location', location: { latitude, longitude, name, address } },
    { location: { latitude, longitude, name, address } }
  );
  return metaRes;
}

export async function sendTemplate(to, templateName, languageCode = 'en_US', components = []) {
  const { metaRes } = await sendAndSave(
    to, 'template',
    { messaging_product: 'whatsapp', to, type: 'template', template: { name: templateName, language: { code: languageCode }, components } },
    { body: `[template:${templateName}]`, rawPayload: { templateName, languageCode, components } }
  );
  return metaRes;
}

export async function sendButtons(to, bodyText, buttons, headerText = '', footerText = '') {
  const interactive = { type: 'button', body: { text: bodyText }, action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } };
  if (headerText) interactive.header = { type: 'text', text: headerText };
  if (footerText) interactive.footer = { text: footerText };
  const { metaRes } = await sendAndSave(
    to, 'interactive',
    { messaging_product: 'whatsapp', to, type: 'interactive', interactive },
    { body: bodyText, rawPayload: { type: 'button', headerText, bodyText, footerText, buttons } }
  );
  return metaRes;
}

export async function sendList(to, bodyText, buttonLabel, sections) {
  const { metaRes } = await sendAndSave(
    to, 'interactive',
    { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'list', body: { text: bodyText }, action: { button: buttonLabel, sections } } },
    { body: bodyText, rawPayload: { type: 'list', bodyText, buttonLabel, sections } }
  );
  return metaRes;
}

export async function markRead(messageId) {
  try {
    await axios.post(`${BASE_URL()}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: messageId }, { headers: { ...authHeader(), 'Content-Type': 'application/json' } });
    await Message.collection.updateOne({ messageId }, { $set: { status: 'read', updatedAt: new Date() } });
  } catch (err) {
    console.error(`⚠️  markRead(${messageId}): ${err.message}`);
  }
}
