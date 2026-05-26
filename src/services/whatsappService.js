/**
 * whatsappService.js — OUTBOUND: business → customer
 */

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
  console.log(`   📡 Calling Meta API: ${BASE_URL()}/messages`);
  console.log(`   📡 Payload: ${JSON.stringify(payload)}`);
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
    console.log(`   ✅ Contact upserted: ${phone}`);
  } catch (err) {
    console.error(`   ⚠️  upsertContact(${phone}): ${err.message}`);
  }
}

// ─── Core: send to Meta + save to MongoDB ────────────────────────────────────
// NOTE: parameter renamed to msgType to avoid shadowing metaPayload.type
async function sendAndSave(to, msgType, metaPayload, extraFields = {}) {
  const toPhone   = (to || '').toString().trim();
  const fromPhone = MY_PHONE();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📤 OUTBOUND ${msgType.toUpperCase()}`);
  console.log(`   from      : ${fromPhone || '❌ WA_BUSINESS_PHONE NOT SET'}`);
  console.log(`   to        : ${toPhone}`);
  console.log(`   body      : ${extraFields.body || '—'}`);
  console.log(`   media     : ${JSON.stringify(extraFields.media || null)}`);
  console.log(`   WA_PHONE_NUMBER_ID: ${process.env.WA_PHONE_NUMBER_ID || '❌ NOT SET'}`);
  console.log(`   WA_API_VERSION    : ${process.env.WA_API_VERSION     || '❌ NOT SET'}`);
  console.log(`   WA_ACCESS_TOKEN   : ${process.env.WA_ACCESS_TOKEN ? process.env.WA_ACCESS_TOKEN.substring(0,15)+'...' : '❌ NOT SET'}`);

  if (!toPhone) throw new Error(`"to" phone number is required`);

  // Step 1: Send to Meta
  console.log(`\n   [1] Sending to Meta...`);
  const metaRes       = await postMessage(metaPayload);
  const realMessageId = metaRes?.messages?.[0]?.id;
  if (!realMessageId) throw new Error(`Meta returned no messageId: ${JSON.stringify(metaRes)}`);
  console.log(`   [2] messageId: ${realMessageId}`);

  // Step 2: Save to MongoDB using raw collection driver
  // IMPORTANT: Message.findOneAndUpdate strips 'type' field (Mongoose reserved keyword)
  // So we use Message.collection.updateOne (raw MongoDB driver) instead
  console.log(`   [3] Saving to MongoDB...`);
  try {
    const now    = new Date();
    const result = await Message.collection.updateOne(
      { messageId: realMessageId },
      {
        $set: {
          messageId:   realMessageId,
          direction:   'outbound',
          from:        fromPhone,
          to:          toPhone,
          type:        msgType,
          status:      'sent',
          waTimestamp: now,
          body:        extraFields.body       || null,
          media:       extraFields.media      || null,
          location:    extraFields.location   || null,
          rawPayload:  extraFields.rawPayload || null,
          updatedAt:   now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
    console.log(`   [4] ✅ DB saved: matched=${result.matchedCount} upserted=${result.upsertedCount}`);
    console.log(`        type=${msgType} body=${extraFields.body||'—'}`);

    // Verify immediately
    const verify = await Message.collection.findOne({ messageId: realMessageId });
    console.log(`   [4] Verify: type=${verify?.type} body=${verify?.body} direction=${verify?.direction}`);
  } catch (dbErr) {
    console.error(`   ❌ DB save FAILED: ${dbErr.message}`);
    console.error(`      ${dbErr.stack}`);
  }

  // Step 3: Upsert contact
  await upsertContact(toPhone);
  console.log(`${'═'.repeat(60)}\n`);

  return { metaRes, realMessageId };
}

// ─── Store media to MinIO and update DB record ────────────────────────────────
async function storeMediaAndUpdate(messageId, opts, mimeType) {
  console.log(`\n   ┌─ storeMediaAndUpdate ─────────────────────`);
  console.log(`   │ messageId : ${messageId}`);
  console.log(`   │ mimeType  : ${mimeType}`);
  console.log(`   │ filePath  : ${opts.filePath || '—'}`);
  console.log(`   │ url       : ${opts.url      || '—'}`);
  console.log(`   │ mediaId   : ${opts.mediaId  || '—'}`);

  try {
    let stored = {};
    const prefix = `whatsapp/outbound/${mediaTypeFolder(mimeType)}`;

    if (opts.filePath && fs.existsSync(opts.filePath)) {
      console.log(`   │ → Case 1: local file`);
      stored = await storeLocalFile(opts.filePath, mimeType);

    } else if (opts.url) {
      console.log(`   │ → Case 2: public URL`);
      stored = await downloadUrlAndStore(opts.url, mimeType, prefix);

    } else if (opts.mediaId) {
      console.log(`   │ → Case 3: WA CDN download`);
      const { downloadAndStoreMedia } = await import('./mediaService.js');
      stored = await downloadAndStoreMedia(opts.mediaId, mimeType, prefix);

    } else {
      console.warn(`   │ ⚠️  No filePath/url/mediaId — nothing to store`);
      console.log(`   └───────────────────────────────────────────\n`);
      return;
    }

    console.log(`   │ stored: ${JSON.stringify(stored)}`);

    if (stored.minioUrl || stored.localPath) {
      const update = {};
      if (stored.minioKey)     update['media.minioKey']     = stored.minioKey;
      if (stored.minioUrl)     update['media.minioUrl']     = stored.minioUrl;
      if (stored.localPath)    update['media.localPath']    = stored.localPath;
      if (stored.fileSize)     update['media.fileSize']     = stored.fileSize;
      if (stored.fileName)     update['media.fileName']     = stored.fileName;
      if (stored.downloadedAt) update['media.downloadedAt'] = stored.downloadedAt;

      await Message.collection.updateOne({ messageId }, { $set: update });
      console.log(`   │ ✅ MinIO stored + DB updated: ${stored.minioUrl || stored.localPath}`);
    } else {
      console.warn(`   │ ⚠️  stored result empty:`, JSON.stringify(stored));
    }
  } catch (err) {
    console.error(`   │ ❌ FAILED: ${err.message}`);
    console.error(`   │    ${err.stack}`);
  }
  console.log(`   └───────────────────────────────────────────\n`);
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

export async function sendText(to, text) {
  // Handle both: plain string "Hello" OR object { body: "Hello" }
  const bodyText = (typeof text === 'object' && text !== null)
    ? (text.body || '')
    : (text || '');

  console.log(`\n🔵 sendText called: to=${to} bodyText="${bodyText}"`);

  const { metaRes } = await sendAndSave(
    to,
    'text',
    {
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to,
      type: 'text',
      text: { body: bodyText },
    },
    { body: bodyText }
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

  await storeMediaAndUpdate(realMessageId, { filePath, url, mediaId: resolvedId }, mimeType);
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

  await storeMediaAndUpdate(realMessageId, { filePath, url, mediaId: resolvedId }, mimeType);
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

  await storeMediaAndUpdate(realMessageId, { filePath, url, mediaId: resolvedId }, mimeType);
  return metaRes;
}

export async function sendDocument(to, { url, mediaId, caption = '', fileName = '', filePath, mimeType = 'application/octet-stream' }) {
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

  const { metaRes, realMessageId } = await sendAndSave(
    to, 'document',
    { messaging_product: 'whatsapp', to, type: 'document', document: docObj },
    { body: caption, media: { mediaId: resolvedId, mimeType, fileName: resolvedName, caption } }
  );

  await storeMediaAndUpdate(realMessageId, { filePath, url, mediaId: resolvedId }, mimeType);
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
    { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'list', body: { text: bodyText }, action: { button: buttonLabel, sections } } },
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
    await Message.collection.updateOne(
      { messageId },
      { $set: { status: 'read', updatedAt: new Date() } }
    );
  } catch (err) {
    console.error(`⚠️  markRead(${messageId}): ${err.message}`);
  }
}
