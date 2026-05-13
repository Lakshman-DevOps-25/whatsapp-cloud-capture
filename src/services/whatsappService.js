/**
 * whatsappService.js — OUTBOUND messages (business → customer)
 *
 * ORDER OF OPERATIONS (guarantees DB + MinIO even if Meta API is slow):
 *   1. Store media in MinIO/local  (if media message)
 *   2. Upload to WhatsApp CDN      (if file upload)
 *   3. POST to Meta Graph API      (deliver to customer)
 *   4. Upsert contact in MongoDB
 *   5. Save message in MongoDB     (with real messageId from Meta)
 */

import axios    from 'axios';
import fs       from 'fs';
import path     from 'path';
import FormData from 'form-data';
import Message  from '../models/Message.js';
import Contact  from '../models/Contact.js';
import { mediaTypeFolder, downloadUrlAndStore, storeLocalFile } from './mediaService.js';

const BASE_URL   = () => `https://graph.facebook.com/${process.env.WA_API_VERSION}/${process.env.WA_PHONE_NUMBER_ID}`;
const authHeader = () => ({ Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` });

// ─── Low-level POST ───────────────────────────────────────────────────────────
async function postMessage(payload) {
  console.log(`   📡 POST to Meta API...`);
  const { data } = await axios.post(`${BASE_URL()}/messages`, payload, {
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  console.log(`   📡 Meta response:`, JSON.stringify(data));
  return data;
}

// ─── Extract messageId ────────────────────────────────────────────────────────
function extractMessageId(res, type) {
  const id = res?.messages?.[0]?.id;
  if (!id) throw new Error(`Meta did not return messageId for ${type}. Response: ${JSON.stringify(res)}`);
  return id;
}

// ─── Upsert contact ───────────────────────────────────────────────────────────
async function upsertContact(phone) {
  try {
    await Contact.findOneAndUpdate(
      { phone },
      { $set: { phone, waId: phone, lastSeen: new Date() }, $inc: { messageCount: 1 }, $setOnInsert: { firstSeen: new Date() } },
      { upsert: true, new: true }
    );
    console.log(`   👤 Contact upserted: ${phone}`);
  } catch (err) {
    console.error(`   ⚠️  upsertContact(${phone}):`, err.message);
  }
}

// ─── Save outbound to MongoDB ─────────────────────────────────────────────────
async function saveOutbound(to, type, messageId, fields = {}) {
  console.log(`   💾 Saving to MongoDB... messageId=${messageId} type=${type} to=${to}`);
  if (!messageId) throw new Error(`saveOutbound: no messageId (type=${type} to=${to})`);

  const doc = {
    messageId,
    direction:   'outbound',
    from:        (process.env.WA_BUSINESS_PHONE || process.env.WA_PHONE_NUMBER_ID).trim(),
    to,
    type,
    waTimestamp: new Date(),
    status:      'sent',
  };
  if (fields.body)     doc.body     = fields.body;
  if (fields.media)    doc.media    = fields.media;
  if (fields.location) doc.location = fields.location;
  if (fields.rawPayload) doc.rawPayload = fields.rawPayload;

  const saved = await Message.findOneAndUpdate(
    { messageId },
    { $set: doc },
    { upsert: true, new: true }
  );
  console.log(`   ✅ MongoDB saved: _id=${saved._id} direction=outbound`);
  return saved;
}

// ─── Store media (MinIO or local) — throws on failure ────────────────────────
async function storeMedia(opts, mimeType) {
  if (opts.filePath) {
    return await storeLocalFile(opts.filePath, mimeType);
  }
  if (opts.url) {
    const prefix = `whatsapp/outbound/${mediaTypeFolder(mimeType)}`;
    return await downloadUrlAndStore(opts.url, mimeType, prefix);
  }
  return {}; // mediaId only — nothing to store
}

// ─── Upload file to WhatsApp CDN ──────────────────────────────────────────────
export async function uploadMedia(filePath, mimeType) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', fs.createReadStream(filePath), { contentType: mimeType, filename: path.basename(filePath) });
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
  console.log(`\n📤 sendText → to=${to}`);
  try {
    const res       = await postMessage({ messaging_product:'whatsapp', recipient_type:'individual', to, type:'text', text:{ body:text, preview_url:previewUrl } });
    const messageId = extractMessageId(res, 'text');
    await upsertContact(to);
    await saveOutbound(to, 'text', messageId, { body: text });
    return res;
  } catch (err) {
    console.error(`❌ sendText FAILED (to=${to}):`, err.message);
    throw err;
  }
}

// ─── 2. Image ─────────────────────────────────────────────────────────────────
export async function sendImage(to, { url, mediaId, caption='', filePath, mimeType='image/jpeg' }) {
  console.log(`\n📤 sendImage → to=${to} | filePath=${filePath||'none'} | url=${url||'none'} | mediaId=${mediaId||'none'}`);
  try {
    // Step 1: Store copy in MinIO/local
    let stored = {};
    try {
      stored = await storeMedia({ filePath, url }, mimeType);
    } catch (err) {
      console.error(`   ⚠️  MinIO/local store failed (image will still send):`, err.message);
    }

    // Step 2: Get WA mediaId
    let resolvedId = mediaId;
    if (filePath) resolvedId = await uploadMedia(filePath, mimeType);
    if (!resolvedId && !url) throw new Error('sendImage: provide url, mediaId, or filePath');

    // Step 3: Send via Meta
    const imageObj = resolvedId ? { id: resolvedId } : { link: url };
    if (caption) imageObj.caption = caption;
    const res       = await postMessage({ messaging_product:'whatsapp', to, type:'image', image:imageObj });
    const messageId = extractMessageId(res, 'image');

    // Step 4+5: Contact + DB
    await upsertContact(to);
    await saveOutbound(to, 'image', messageId, {
      body:  caption,
      media: { mediaId: resolvedId, mimeType, caption, ...stored },
    });
    return res;
  } catch (err) {
    console.error(`❌ sendImage FAILED (to=${to}):`, err.message);
    throw err;
  }
}

// ─── 3. Video ─────────────────────────────────────────────────────────────────
export async function sendVideo(to, { url, mediaId, caption='', filePath, mimeType='video/mp4' }) {
  console.log(`\n📤 sendVideo → to=${to} | filePath=${filePath||'none'} | url=${url||'none'}`);
  try {
    let stored = {};
    try { stored = await storeMedia({ filePath, url }, mimeType); }
    catch (err) { console.error(`   ⚠️  store failed:`, err.message); }

    let resolvedId = mediaId;
    if (filePath) resolvedId = await uploadMedia(filePath, mimeType);
    if (!resolvedId && !url) throw new Error('sendVideo: provide url, mediaId, or filePath');

    const videoObj = resolvedId ? { id: resolvedId } : { link: url };
    if (caption) videoObj.caption = caption;
    const res       = await postMessage({ messaging_product:'whatsapp', to, type:'video', video:videoObj });
    const messageId = extractMessageId(res, 'video');
    await upsertContact(to);
    await saveOutbound(to, 'video', messageId, { body: caption, media:{ mediaId:resolvedId, mimeType, caption, ...stored } });
    return res;
  } catch (err) {
    console.error(`❌ sendVideo FAILED (to=${to}):`, err.message);
    throw err;
  }
}

// ─── 4. Audio ─────────────────────────────────────────────────────────────────
export async function sendAudio(to, { url, mediaId, filePath, mimeType='audio/mpeg' }) {
  console.log(`\n📤 sendAudio → to=${to} | filePath=${filePath||'none'} | url=${url||'none'}`);
  try {
    let stored = {};
    try { stored = await storeMedia({ filePath, url }, mimeType); }
    catch (err) { console.error(`   ⚠️  store failed:`, err.message); }

    let resolvedId = mediaId;
    if (filePath) resolvedId = await uploadMedia(filePath, mimeType);
    if (!resolvedId && !url) throw new Error('sendAudio: provide url, mediaId, or filePath');

    const audioObj = resolvedId ? { id: resolvedId } : { link: url };
    const res       = await postMessage({ messaging_product:'whatsapp', to, type:'audio', audio:audioObj });
    const messageId = extractMessageId(res, 'audio');
    await upsertContact(to);
    await saveOutbound(to, 'audio', messageId, { media:{ mediaId:resolvedId, mimeType, ...stored } });
    return res;
  } catch (err) {
    console.error(`❌ sendAudio FAILED (to=${to}):`, err.message);
    throw err;
  }
}

// ─── 5. Document ──────────────────────────────────────────────────────────────
export async function sendDocument(to, { url, mediaId, caption='', fileName='', filePath, mimeType='application/octet-stream' }) {
  console.log(`\n📤 sendDocument → to=${to} | filePath=${filePath||'none'} | url=${url||'none'}`);
  try {
    let stored = {};
    try { stored = await storeMedia({ filePath, url }, mimeType); }
    catch (err) { console.error(`   ⚠️  store failed:`, err.message); }

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

    const res       = await postMessage({ messaging_product:'whatsapp', to, type:'document', document:docObj });
    const messageId = extractMessageId(res, 'document');
    await upsertContact(to);
    await saveOutbound(to, 'document', messageId, { body:caption, media:{ mediaId:resolvedId, mimeType, fileName:resolvedName, caption, ...stored } });
    return res;
  } catch (err) {
    console.error(`❌ sendDocument FAILED (to=${to}):`, err.message);
    throw err;
  }
}

// ─── 6. Sticker ───────────────────────────────────────────────────────────────
export async function sendSticker(to, { url, mediaId }) {
  console.log(`\n📤 sendSticker → to=${to}`);
  try {
    const obj = mediaId ? { id:mediaId } : { link:url };
    const res       = await postMessage({ messaging_product:'whatsapp', to, type:'sticker', sticker:obj });
    const messageId = extractMessageId(res, 'sticker');
    await upsertContact(to);
    await saveOutbound(to, 'sticker', messageId, { media:{ mediaId, mimeType:'image/webp' } });
    return res;
  } catch (err) {
    console.error(`❌ sendSticker FAILED (to=${to}):`, err.message);
    throw err;
  }
}

// ─── 7. Location ──────────────────────────────────────────────────────────────
export async function sendLocation(to, { latitude, longitude, name='', address='' }) {
  console.log(`\n📤 sendLocation → to=${to}`);
  try {
    const res       = await postMessage({ messaging_product:'whatsapp', to, type:'location', location:{ latitude, longitude, name, address } });
    const messageId = extractMessageId(res, 'location');
    await upsertContact(to);
    await saveOutbound(to, 'location', messageId, { location:{ latitude, longitude, name, address } });
    return res;
  } catch (err) {
    console.error(`❌ sendLocation FAILED (to=${to}):`, err.message);
    throw err;
  }
}

// ─── 8. Template ──────────────────────────────────────────────────────────────
export async function sendTemplate(to, templateName, languageCode='en_US', components=[]) {
  console.log(`\n📤 sendTemplate "${templateName}" → to=${to}`);
  try {
    const res       = await postMessage({ messaging_product:'whatsapp', to, type:'template', template:{ name:templateName, language:{ code:languageCode }, components } });
    const messageId = extractMessageId(res, 'template');
    await upsertContact(to);
    await saveOutbound(to, 'template', messageId, { body:`[template:${templateName}]`, rawPayload:{ templateName, languageCode, components } });
    return res;
  } catch (err) {
    console.error(`❌ sendTemplate FAILED (to=${to}):`, err.message);
    throw err;
  }
}

// ─── 9. Buttons ───────────────────────────────────────────────────────────────
export async function sendButtons(to, bodyText, buttons, headerText='', footerText='') {
  console.log(`\n📤 sendButtons → to=${to}`);
  try {
    const payload = {
      messaging_product:'whatsapp', to, type:'interactive',
      interactive:{ type:'button', body:{ text:bodyText }, action:{ buttons:buttons.map(b=>({ type:'reply', reply:{ id:b.id, title:b.title } })) } },
    };
    if (headerText) payload.interactive.header = { type:'text', text:headerText };
    if (footerText) payload.interactive.footer = { text:footerText };
    const res       = await postMessage(payload);
    const messageId = extractMessageId(res, 'buttons');
    await upsertContact(to);
    await saveOutbound(to, 'interactive', messageId, { body:bodyText, rawPayload:{ type:'button', headerText, bodyText, footerText, buttons } });
    return res;
  } catch (err) {
    console.error(`❌ sendButtons FAILED (to=${to}):`, err.message);
    throw err;
  }
}

// ─── 10. List ─────────────────────────────────────────────────────────────────
export async function sendList(to, bodyText, buttonLabel, sections) {
  console.log(`\n📤 sendList → to=${to}`);
  try {
    const res       = await postMessage({ messaging_product:'whatsapp', to, type:'interactive', interactive:{ type:'list', body:{ text:bodyText }, action:{ button:buttonLabel, sections } } });
    const messageId = extractMessageId(res, 'list');
    await upsertContact(to);
    await saveOutbound(to, 'interactive', messageId, { body:bodyText, rawPayload:{ type:'list', bodyText, buttonLabel, sections } });
    return res;
  } catch (err) {
    console.error(`❌ sendList FAILED (to=${to}):`, err.message);
    throw err;
  }
}

// ─── 11. Mark read ────────────────────────────────────────────────────────────
export async function markRead(messageId) {
  try {
    await axios.post(`${BASE_URL()}/messages`, { messaging_product:'whatsapp', status:'read', message_id:messageId }, { headers:{ ...authHeader(), 'Content-Type':'application/json' } });
    await Message.findOneAndUpdate({ messageId }, { $set:{ status:'read' } });
  } catch (err) {
    console.error(`⚠️  markRead(${messageId}):`, err.message);
  }
}
