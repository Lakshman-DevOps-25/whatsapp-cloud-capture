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
const MY_PHONE   = () => (process.env.WA_BUSINESS_PHONE || process.env.WA_PHONE_NUMBER_ID || '').trim();
const authHeader = () => ({ Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` });

// ─── POST to Meta ─────────────────────────────────────────────────────────────
async function postMessage(payload) {
  console.log(`   📡 Meta URL: ${BASE_URL()}/messages`);
  const { data } = await axios.post(`${BASE_URL()}/messages`, payload, {
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  console.log(`   📡 Meta response: ${JSON.stringify(data)}`);
  return data;
}

// ─── Save outbound — direct insert, no helpers, maximum logging ───────────────
async function saveOutbound(to, type, messageId, fields = {}) {
  console.log(`\n   ════ saveOutbound START ════`);
  console.log(`   type      = ${type}`);
  console.log(`   to        = ${to}`);
  console.log(`   messageId = ${messageId}`);
  console.log(`   from      = ${MY_PHONE()}`);
  console.log(`   WA_BUSINESS_PHONE env = "${process.env.WA_BUSINESS_PHONE}"`);
  console.log(`   WA_PHONE_NUMBER_ID env = "${process.env.WA_PHONE_NUMBER_ID}"`);

  if (!messageId) {
    console.error(`   ❌ saveOutbound: messageId is empty!`);
    throw new Error(`saveOutbound: no messageId`);
  }

  // Ensure to is always a trimmed string — never null/undefined
  const toPhone = (to || '').toString().trim();
  if (!toPhone) throw new Error(`saveOutbound: "to" is empty (type=${type} messageId=${messageId})`);

  const doc = {
    messageId,
    direction:   'outbound',
    from:        MY_PHONE(),
    to:          toPhone,
    type,
    waTimestamp: new Date(),
    status:      'sent',
  };

  if (fields.body)       doc.body       = fields.body;
  if (fields.media)      doc.media      = fields.media;
  if (fields.location)   doc.location   = fields.location;
  if (fields.rawPayload) doc.rawPayload = fields.rawPayload;

  console.log(`   💾 Calling Message.findOneAndUpdate...`);

  let saved;
  try {
    saved = await Message.findOneAndUpdate(
      { messageId },
      { $set: doc },
      { upsert: true, new: true }
    );
  } catch (dbErr) {
    console.error(`   ❌ MongoDB findOneAndUpdate THREW: ${dbErr.message}`);
    console.error(`   ❌ Stack: ${dbErr.stack}`);
    throw dbErr;
  }

  if (!saved) {
    console.error(`   ❌ findOneAndUpdate returned null/undefined`);
    throw new Error(`saveOutbound: DB returned null for messageId=${messageId}`);
  }

  console.log(`   ✅ saveOutbound SUCCESS: _id=${saved._id} direction=${saved.direction} from=${saved.from} to=${saved.to}`);
  console.log(`   ════ saveOutbound END ════\n`);
  return saved;
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
    console.error(`   ⚠️  upsertContact(${phone}): ${err.message}`);
  }
}

// ─── Store media ──────────────────────────────────────────────────────────────
async function storeMedia(opts, mimeType) {
  if (opts.filePath) {
    console.log(`   📁 storeLocalFile: ${opts.filePath}`);
    return await storeLocalFile(opts.filePath, mimeType);
  }
  if (opts.url) {
    console.log(`   🌍 downloadUrlAndStore: ${opts.url}`);
    const prefix = `whatsapp/outbound/${mediaTypeFolder(mimeType)}`;
    return await downloadUrlAndStore(opts.url, mimeType, prefix);
  }
  return {};
}

// ─── Upload to WA CDN ─────────────────────────────────────────────────────────
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
// SEND FUNCTIONS — each logs every step explicitly
// ─────────────────────────────────────────────────────────────────────────────

export async function sendText(to, text, previewUrl = false) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📤 sendText START → to=${to} text="${text}"`);
  console.log(`${'═'.repeat(60)}`);
  try {
    console.log(`   [1/4] Calling Meta API...`);
    const res = await postMessage({
      messaging_product: 'whatsapp', recipient_type: 'individual',
      to, type: 'text', text: { body: text, preview_url: previewUrl },
    });

    console.log(`   [2/4] Extracting messageId...`);
    const messageId = res?.messages?.[0]?.id;
    console.log(`   messageId = "${messageId}"`);
    if (!messageId) throw new Error(`Meta no messageId. Response: ${JSON.stringify(res)}`);

    console.log(`   [3/4] Upsert contact...`);
    await upsertContact(to);

    console.log(`   [4/4] Save to DB...`);
    await saveOutbound(to, 'text', messageId, { body: text });

    console.log(`📤 sendText COMPLETE ✅`);
    return res;
  } catch (err) {
    console.error(`❌ sendText FAILED at step: ${err.message}`);
    console.error(`   Stack: ${err.stack}`);
    throw err;
  }
}

export async function sendImage(to, { url, mediaId, caption = '', filePath, mimeType = 'image/jpeg' }) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📤 sendImage START → to=${to} filePath=${filePath||'none'} url=${url||'none'}`);
  console.log(`${'═'.repeat(60)}`);
  try {
    console.log(`   [1/5] Store media...`);
    let stored = {};
    try { stored = await storeMedia({ filePath, url }, mimeType); }
    catch (e) { console.error(`   ⚠️  storeMedia failed (non-fatal): ${e.message}`); }

    console.log(`   [2/5] Get WA mediaId...`);
    let resolvedId = mediaId;
    if (filePath) resolvedId = await uploadMedia(filePath, mimeType);
    if (!resolvedId && !url) throw new Error('sendImage: need url, mediaId, or filePath');

    console.log(`   [3/5] Call Meta API...`);
    const imageObj = resolvedId ? { id: resolvedId } : { link: url };
    if (caption) imageObj.caption = caption;
    const res = await postMessage({ messaging_product: 'whatsapp', to, type: 'image', image: imageObj });

    console.log(`   [4/5] Extract messageId...`);
    const messageId = res?.messages?.[0]?.id;
    console.log(`   messageId = "${messageId}"`);
    if (!messageId) throw new Error(`Meta no messageId. Response: ${JSON.stringify(res)}`);

    console.log(`   [5/5] Upsert contact + save to DB...`);
    await upsertContact(to);
    await saveOutbound(to, 'image', messageId, { body: caption, media: { mediaId: resolvedId, mimeType, caption, ...stored } });

    console.log(`📤 sendImage COMPLETE ✅`);
    return res;
  } catch (err) {
    console.error(`❌ sendImage FAILED: ${err.message}`);
    console.error(`   Stack: ${err.stack}`);
    throw err;
  }
}

export async function sendVideo(to, { url, mediaId, caption = '', filePath, mimeType = 'video/mp4' }) {
  console.log(`\n📤 sendVideo → to=${to}`);
  try {
    let stored = {};
    try { stored = await storeMedia({ filePath, url }, mimeType); } catch (e) { console.error(`   ⚠️  storeMedia: ${e.message}`); }
    let resolvedId = mediaId;
    if (filePath) resolvedId = await uploadMedia(filePath, mimeType);
    if (!resolvedId && !url) throw new Error('sendVideo: need url, mediaId, or filePath');
    const videoObj = resolvedId ? { id: resolvedId } : { link: url };
    if (caption) videoObj.caption = caption;
    const res       = await postMessage({ messaging_product: 'whatsapp', to, type: 'video', video: videoObj });
    const messageId = res?.messages?.[0]?.id;
    if (!messageId) throw new Error(`Meta no messageId. Response: ${JSON.stringify(res)}`);
    await upsertContact(to);
    await saveOutbound(to, 'video', messageId, { body: caption, media: { mediaId: resolvedId, mimeType, caption, ...stored } });
    console.log(`📤 sendVideo COMPLETE ✅`);
    return res;
  } catch (err) { console.error(`❌ sendVideo FAILED: ${err.message}`); throw err; }
}

export async function sendAudio(to, { url, mediaId, filePath, mimeType = 'audio/mpeg' }) {
  console.log(`\n📤 sendAudio → to=${to}`);
  try {
    let stored = {};
    try { stored = await storeMedia({ filePath, url }, mimeType); } catch (e) { console.error(`   ⚠️  storeMedia: ${e.message}`); }
    let resolvedId = mediaId;
    if (filePath) resolvedId = await uploadMedia(filePath, mimeType);
    if (!resolvedId && !url) throw new Error('sendAudio: need url, mediaId, or filePath');
    const audioObj  = resolvedId ? { id: resolvedId } : { link: url };
    const res       = await postMessage({ messaging_product: 'whatsapp', to, type: 'audio', audio: audioObj });
    const messageId = res?.messages?.[0]?.id;
    if (!messageId) throw new Error(`Meta no messageId. Response: ${JSON.stringify(res)}`);
    await upsertContact(to);
    await saveOutbound(to, 'audio', messageId, { media: { mediaId: resolvedId, mimeType, ...stored } });
    console.log(`📤 sendAudio COMPLETE ✅`);
    return res;
  } catch (err) { console.error(`❌ sendAudio FAILED: ${err.message}`); throw err; }
}

export async function sendDocument(to, { url, mediaId, caption = '', fileName = '', filePath, mimeType = 'application/octet-stream' }) {
  console.log(`\n📤 sendDocument → to=${to}`);
  try {
    let stored = {};
    try { stored = await storeMedia({ filePath, url }, mimeType); } catch (e) { console.error(`   ⚠️  storeMedia: ${e.message}`); }
    let resolvedId = mediaId, resolvedName = fileName;
    if (filePath) { resolvedId = await uploadMedia(filePath, mimeType); resolvedName = resolvedName || path.basename(filePath); }
    if (!resolvedId && !url) throw new Error('sendDocument: need url, mediaId, or filePath');
    const docObj = resolvedId ? { id: resolvedId } : { link: url };
    if (caption)      docObj.caption  = caption;
    if (resolvedName) docObj.filename = resolvedName;
    const res       = await postMessage({ messaging_product: 'whatsapp', to, type: 'document', document: docObj });
    const messageId = res?.messages?.[0]?.id;
    if (!messageId) throw new Error(`Meta no messageId. Response: ${JSON.stringify(res)}`);
    await upsertContact(to);
    await saveOutbound(to, 'document', messageId, { body: caption, media: { mediaId: resolvedId, mimeType, fileName: resolvedName, caption, ...stored } });
    console.log(`📤 sendDocument COMPLETE ✅`);
    return res;
  } catch (err) { console.error(`❌ sendDocument FAILED: ${err.message}`); throw err; }
}

export async function sendSticker(to, { url, mediaId }) {
  console.log(`\n📤 sendSticker → to=${to}`);
  try {
    const obj       = mediaId ? { id: mediaId } : { link: url };
    const res       = await postMessage({ messaging_product: 'whatsapp', to, type: 'sticker', sticker: obj });
    const messageId = res?.messages?.[0]?.id;
    if (!messageId) throw new Error(`Meta no messageId`);
    await upsertContact(to);
    await saveOutbound(to, 'sticker', messageId, { media: { mediaId, mimeType: 'image/webp' } });
    return res;
  } catch (err) { console.error(`❌ sendSticker FAILED: ${err.message}`); throw err; }
}

export async function sendLocation(to, { latitude, longitude, name = '', address = '' }) {
  console.log(`\n📤 sendLocation → to=${to}`);
  try {
    const res       = await postMessage({ messaging_product: 'whatsapp', to, type: 'location', location: { latitude, longitude, name, address } });
    const messageId = res?.messages?.[0]?.id;
    if (!messageId) throw new Error(`Meta no messageId`);
    await upsertContact(to);
    await saveOutbound(to, 'location', messageId, { location: { latitude, longitude, name, address } });
    return res;
  } catch (err) { console.error(`❌ sendLocation FAILED: ${err.message}`); throw err; }
}

export async function sendTemplate(to, templateName, languageCode = 'en_US', components = []) {
  console.log(`\n📤 sendTemplate "${templateName}" → to=${to}`);
  try {
    const res       = await postMessage({ messaging_product: 'whatsapp', to, type: 'template', template: { name: templateName, language: { code: languageCode }, components } });
    const messageId = res?.messages?.[0]?.id;
    if (!messageId) throw new Error(`Meta no messageId`);
    await upsertContact(to);
    await saveOutbound(to, 'template', messageId, { body: `[template:${templateName}]`, rawPayload: { templateName, languageCode, components } });
    return res;
  } catch (err) { console.error(`❌ sendTemplate FAILED: ${err.message}`); throw err; }
}

export async function sendButtons(to, bodyText, buttons, headerText = '', footerText = '') {
  console.log(`\n📤 sendButtons → to=${to}`);
  try {
    const payload = { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'button', body: { text: bodyText }, action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } } };
    if (headerText) payload.interactive.header = { type: 'text', text: headerText };
    if (footerText) payload.interactive.footer = { text: footerText };
    const res       = await postMessage(payload);
    const messageId = res?.messages?.[0]?.id;
    if (!messageId) throw new Error(`Meta no messageId`);
    await upsertContact(to);
    await saveOutbound(to, 'interactive', messageId, { body: bodyText, rawPayload: { type: 'button', headerText, bodyText, footerText, buttons } });
    return res;
  } catch (err) { console.error(`❌ sendButtons FAILED: ${err.message}`); throw err; }
}

export async function sendList(to, bodyText, buttonLabel, sections) {
  console.log(`\n📤 sendList → to=${to}`);
  try {
    const res       = await postMessage({ messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'list', body: { text: bodyText }, action: { button: buttonLabel, sections } } });
    const messageId = res?.messages?.[0]?.id;
    if (!messageId) throw new Error(`Meta no messageId`);
    await upsertContact(to);
    await saveOutbound(to, 'interactive', messageId, { body: bodyText, rawPayload: { type: 'list', bodyText, buttonLabel, sections } });
    return res;
  } catch (err) { console.error(`❌ sendList FAILED: ${err.message}`); throw err; }
}

export async function markRead(messageId) {
  try {
    await axios.post(`${BASE_URL()}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: messageId }, { headers: { ...authHeader(), 'Content-Type': 'application/json' } });
    await Message.findOneAndUpdate({ messageId }, { $set: { status: 'read' } });
  } catch (err) { console.error(`⚠️  markRead(${messageId}): ${err.message}`); }
}
