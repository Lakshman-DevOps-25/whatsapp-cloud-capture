/**
 * whatsappService.js — OUTBOUND: business → customer
 *
 * Uses the EXACT same MongoDB save pattern as inbound (webhook.js):
 *   mongoose.connection.db.collection('messages').updateOne(
 *     { messageId },
 *     { $set: { ...doc, updatedAt: now }, $setOnInsert: { createdAt: now } },
 *     { upsert: true }
 *   )
 */

import axios    from 'axios';
import fs       from 'fs';
import path     from 'path';
import FormData from 'form-data';
import mongoose from 'mongoose';
import Contact  from '../models/Contact.js';
import { mediaTypeFolder, downloadUrlAndStore, storeLocalFile } from './mediaService.js';

const BASE_URL   = () => `https://graph.facebook.com/${process.env.WA_API_VERSION}/${process.env.WA_PHONE_NUMBER_ID}`;
const MY_PHONE   = () => (process.env.WA_BUSINESS_PHONE || '').trim();
const authHeader = () => ({ Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` });

// ─── POST to Meta API ─────────────────────────────────────────────────────────
async function postMessage(payload) {
  const { data } = await axios.post(`${BASE_URL()}/messages`, payload, {
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  console.log(`   📡 Meta response: ${JSON.stringify(data)}`);
  return data;
}

// ─── Save to MongoDB — tries Message.collection first, falls back to mongoose.connection.db ──
async function saveMessage(doc) {
  const now = new Date();
  const setDoc = { ...doc, updatedAt: now };
  const filter = { messageId: doc.messageId };
  const update = { $set: setDoc, $setOnInsert: { createdAt: now } };
  const opts   = { upsert: true };

  console.log(`   💾 Saving: messageId=${doc.messageId} type=${doc.type} from=${doc.from} to=${doc.to}`);
  console.log(`   💾 mongoose readyState=${mongoose.connection.readyState} db=${mongoose.connection.db?.databaseName}`);

  let result;

  // Method 1: Message.collection (Mongoose model collection — used by inbound webhook)
  try {
    result = await mongoose.connection.db.collection('messages').updateOne(filter, update, opts);
    console.log(`   ✅ Saved via mongoose.connection.db: matched=${result.matchedCount} upserted=${result.upsertedCount}`);
    return result;
  } catch (err1) {
    console.error(`   ⚠️  mongoose.connection.db failed: ${err1.message}`);
  }

  // Method 2: Message.collection (Mongoose model)
  try {
    const { default: Message } = await import('../models/Message.js');
    result = await Message.collection.updateOne(filter, update, opts);
    console.log(`   ✅ Saved via Message.collection: matched=${result.matchedCount} upserted=${result.upsertedCount}`);
    return result;
  } catch (err2) {
    console.error(`   ⚠️  Message.collection failed: ${err2.message}`);
  }

  // Method 3: Mongoose findOneAndUpdate (last resort)
  try {
    const { default: Message } = await import('../models/Message.js');
    const saved = await Message.collection.findOneAndUpdate(filter, { $set: setDoc }, { upsert: true, returnDocument: 'after' });
    console.log(`   ✅ Saved via findOneAndUpdate: _id=${saved?._id}`);
    return saved;
  } catch (err3) {
    console.error(`   ❌ ALL save methods failed: ${err3.message}`);
    throw err3;
  }
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

// ─── Core: send to Meta + save to MongoDB ────────────────────────────────────
async function sendAndSave(to, msgType, metaPayload, extraFields = {}) {
  const toPhone   = (to || '').toString().trim();
  const fromPhone = MY_PHONE();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📤 SEND ${msgType.toUpperCase()} | from=${fromPhone || '(WA_BUSINESS_PHONE NOT SET)'} | to=${toPhone}`);

  if (!toPhone) throw new Error(`"to" is required`);

  // 1. Send to Meta
  const metaRes       = await postMessage(metaPayload);
  const realMessageId = metaRes?.messages?.[0]?.id;
  if (!realMessageId) throw new Error(`Meta returned no messageId: ${JSON.stringify(metaRes)}`);
  console.log(`   🆔 messageId=${realMessageId}`);

  // 2. Build document — same structure as inbound doc in webhook.js
  const doc = {
    messageId:   realMessageId,
    direction:   'outbound',
    from:        fromPhone,
    to:          toPhone,
    type:        msgType,
    status:      'sent',
    waTimestamp: new Date(),
  };

  if (extraFields.body)       doc.body       = extraFields.body;
  if (extraFields.media)      doc.media      = extraFields.media;
  if (extraFields.location)   doc.location   = extraFields.location;
  if (extraFields.rawPayload) doc.rawPayload = extraFields.rawPayload;

  // 3. Save to MongoDB
  console.log(`   [3] Calling saveMessage type=${msgType} to=${toPhone}`);
  try {
    await saveMessage(doc);
    console.log(`   [4] saveMessage OK`);
  } catch (saveErr) {
    console.error(`   ❌ saveMessage THREW: ${saveErr.message}`);
    console.error(`      Stack: ${saveErr.stack}`);
    throw saveErr;
  }

  // 4. Upsert contact
  await upsertContact(toPhone);

  console.log(`${'═'.repeat(60)}\n`);
  return { metaRes, realMessageId };
}

// ─── Store outbound media in MinIO/local then update DB ──────────────────────
async function storeOutboundMedia(messageId, opts, mimeType) {
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

      const col = mongoose.connection.db.collection('messages');
      await col.updateOne({ messageId }, { $set: update });
      console.log(`   ✅ Outbound media stored: ${stored.minioUrl || stored.localPath}`);
    }
  } catch (err) {
    console.error(`   ❌ Outbound media store FAILED (${messageId}): ${err.message}`);
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

export async function sendText(to, text) {
  const { metaRes } = await sendAndSave(
    to, 'text',
    {
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to,
      type: 'text',
      text: { body: text },
    },
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
  storeOutboundMedia(realMessageId, { filePath, url }, mimeType);
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
  storeOutboundMedia(realMessageId, { filePath, url }, mimeType);
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
  storeOutboundMedia(realMessageId, { filePath, url }, mimeType);
  return metaRes;
}

export async function sendDocument(to, { url, mediaId, caption = '', fileName = '', filePath, mimeType = 'application/octet-stream' }) {
  let resolvedId = mediaId, resolvedName = fileName;
  if (filePath) {
    resolvedId   = await uploadMedia(filePath, mimeType);
    resolvedName = resolvedName || path.basename(filePath);
  }
  if (!resolvedId && !url) throw new Error('sendDocument: provide url, mediaId, or filePath');

  const docObj = resolvedId ? { id: resolvedId } : { link: url };
  if (caption)      docObj.caption  = caption;
  if (resolvedName) docObj.filename = resolvedName;

  const { metaRes, realMessageId } = await sendAndSave(
    to, 'document',
    { messaging_product: 'whatsapp', to, type: 'document', document: docObj },
    { body: caption, media: { mediaId: resolvedId, mimeType, fileName: resolvedName, caption } }
  );
  storeOutboundMedia(realMessageId, { filePath, url }, mimeType);
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
  const interactive = {
    type:   'button',
    body:   { text: bodyText },
    action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
  };
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
    {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: { type: 'list', body: { text: bodyText }, action: { button: buttonLabel, sections } },
    },
    { body: bodyText, rawPayload: { type: 'list', bodyText, buttonLabel, sections } }
  );
  return metaRes;
}

export async function markRead(messageId) {
  try {
    await axios.post(
      `${BASE_URL()}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: { ...authHeader(), 'Content-Type': 'application/json' } }
    );
    const col = mongoose.connection.db.collection('messages');
    await col.updateOne({ messageId }, { $set: { status: 'read', updatedAt: new Date() } });
  } catch (err) {
    console.error(`⚠️  markRead(${messageId}): ${err.message}`);
  }
}
