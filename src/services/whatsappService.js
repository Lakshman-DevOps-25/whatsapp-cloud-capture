/**
 * whatsappService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Helpers for SENDING messages via WhatsApp Cloud API.
 * All sent messages are saved to MongoDB for a full conversation history.
 *
 * Supported outbound types:
 *   sendText       — plain text
 *   sendImage      — image by URL or by uploading a local file
 *   sendVideo      — video by URL or upload
 *   sendAudio      — audio by URL or upload
 *   sendDocument   — document by URL or upload
 *   sendSticker    — sticker by URL
 *   sendLocation   — lat/lng with optional name & address
 *   sendTemplate   — approved template with parameters
 *   sendButtons    — interactive message with up to 3 reply buttons
 *   sendList       — interactive list message
 *   markRead       — mark a message as read (shows blue ticks)
 *   uploadMedia    — upload a local file to WhatsApp CDN → returns media ID
 */

import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';
import Message from '../models/Message.js';

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
  return data; // { messaging_product, contacts[], messages[{ id }] }
}

// ─── Persist outbound message to MongoDB ─────────────────────────────────────
async function saveOutbound(to, type, fields = {}) {
  try {
    const doc = await Message.create({
      messageId:   fields.messageId || `out_${Date.now()}`,
      direction:   'outbound',
      from:        process.env.WA_PHONE_NUMBER_ID,
      to,
      type,
      waTimestamp: new Date(),
      status:      'sent',
      ...fields,
    });
    return doc;
  } catch (err) {
    // Don't crash the app if DB write fails for outbound
    console.error('⚠️  Failed to persist outbound message:', err.message);
  }
}

// ─── 1. Send text ─────────────────────────────────────────────────────────────
export async function sendText(to, text, previewUrl = false) {
  const res = await postMessage({
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to,
    type: 'text',
    text: { body: text, preview_url: previewUrl },
  });
  const msgId = res.messages?.[0]?.id;
  await saveOutbound(to, 'text', { messageId: msgId, body: text });
  return res;
}

// ─── 2. Send image ────────────────────────────────────────────────────────────
export async function sendImage(to, { url, mediaId, caption = '' }) {
  const imageObj = mediaId ? { id: mediaId } : { link: url };
  if (caption) imageObj.caption = caption;

  const res = await postMessage({
    messaging_product: 'whatsapp',
    to,
    type:  'image',
    image: imageObj,
  });
  const msgId = res.messages?.[0]?.id;
  await saveOutbound(to, 'image', {
    messageId: msgId,
    media: { mediaId, caption },
    body: caption,
  });
  return res;
}

// ─── 3. Send video ────────────────────────────────────────────────────────────
export async function sendVideo(to, { url, mediaId, caption = '' }) {
  const videoObj = mediaId ? { id: mediaId } : { link: url };
  if (caption) videoObj.caption = caption;

  const res = await postMessage({
    messaging_product: 'whatsapp',
    to,
    type:  'video',
    video: videoObj,
  });
  const msgId = res.messages?.[0]?.id;
  await saveOutbound(to, 'video', {
    messageId: msgId,
    media: { mediaId, caption },
    body: caption,
  });
  return res;
}

// ─── 4. Send audio ────────────────────────────────────────────────────────────
export async function sendAudio(to, { url, mediaId }) {
  const audioObj = mediaId ? { id: mediaId } : { link: url };

  const res = await postMessage({
    messaging_product: 'whatsapp',
    to,
    type:  'audio',
    audio: audioObj,
  });
  const msgId = res.messages?.[0]?.id;
  await saveOutbound(to, 'audio', { messageId: msgId, media: { mediaId } });
  return res;
}

// ─── 5. Send document ─────────────────────────────────────────────────────────
export async function sendDocument(to, { url, mediaId, caption = '', fileName = '' }) {
  const docObj = mediaId ? { id: mediaId } : { link: url };
  if (caption)  docObj.caption   = caption;
  if (fileName) docObj.filename  = fileName;

  const res = await postMessage({
    messaging_product: 'whatsapp',
    to,
    type:     'document',
    document: docObj,
  });
  const msgId = res.messages?.[0]?.id;
  await saveOutbound(to, 'document', {
    messageId: msgId,
    media: { mediaId, fileName, caption },
    body: caption,
  });
  return res;
}

// ─── 6. Send sticker ──────────────────────────────────────────────────────────
export async function sendSticker(to, { url, mediaId }) {
  const stickerObj = mediaId ? { id: mediaId } : { link: url };

  const res = await postMessage({
    messaging_product: 'whatsapp',
    to,
    type:    'sticker',
    sticker: stickerObj,
  });
  const msgId = res.messages?.[0]?.id;
  await saveOutbound(to, 'sticker', { messageId: msgId, media: { mediaId } });
  return res;
}

// ─── 7. Send location ─────────────────────────────────────────────────────────
export async function sendLocation(to, { latitude, longitude, name = '', address = '' }) {
  const res = await postMessage({
    messaging_product: 'whatsapp',
    to,
    type:     'location',
    location: { latitude, longitude, name, address },
  });
  const msgId = res.messages?.[0]?.id;
  await saveOutbound(to, 'location', {
    messageId: msgId,
    location:  { latitude, longitude, name, address },
  });
  return res;
}

// ─── 8. Send template ─────────────────────────────────────────────────────────
/**
 * @param {string}   to
 * @param {string}   templateName   - approved template name
 * @param {string}   languageCode   - e.g. 'en_US'
 * @param {Array}    components     - template components with parameters
 *
 * Example components:
 * [
 *   { type: 'header', parameters: [{ type: 'image', image: { link: 'https://...' } }] },
 *   { type: 'body',   parameters: [{ type: 'text', text: 'John' }] },
 *   { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'ORDER123' }] }
 * ]
 */
export async function sendTemplate(to, templateName, languageCode = 'en_US', components = []) {
  const res = await postMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name:     templateName,
      language: { code: languageCode },
      components,
    },
  });
  const msgId = res.messages?.[0]?.id;
  await saveOutbound(to, 'template', {
    messageId: msgId,
    body: `[template: ${templateName}]`,
  });
  return res;
}

// ─── 9. Send interactive buttons (up to 3) ────────────────────────────────────
/**
 * @param {string} to
 * @param {string} bodyText    - message body
 * @param {Array}  buttons     - [{ id: 'btn_1', title: 'Yes' }, ...]
 * @param {string} [headerText]
 * @param {string} [footerText]
 */
export async function sendButtons(to, bodyText, buttons, headerText = '', footerText = '') {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map(b => ({
          type:  'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  };
  if (headerText) payload.interactive.header = { type: 'text', text: headerText };
  if (footerText) payload.interactive.footer = { text: footerText };

  const res = await postMessage(payload);
  const msgId = res.messages?.[0]?.id;
  await saveOutbound(to, 'interactive', { messageId: msgId, body: bodyText });
  return res;
}

// ─── 10. Send interactive list ────────────────────────────────────────────────
/**
 * @param {string} to
 * @param {string} bodyText
 * @param {string} buttonLabel  - text on the list trigger button
 * @param {Array}  sections     - [{ title, rows: [{ id, title, description }] }]
 */
export async function sendList(to, bodyText, buttonLabel, sections) {
  const res = await postMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button:   buttonLabel,
        sections,
      },
    },
  });
  const msgId = res.messages?.[0]?.id;
  await saveOutbound(to, 'interactive', { messageId: msgId, body: bodyText });
  return res;
}

// ─── 11. Mark message as read ─────────────────────────────────────────────────
export async function markRead(messageId) {
  await axios.post(
    `${BASE_URL()}/messages`,
    {
      messaging_product: 'whatsapp',
      status:     'read',
      message_id: messageId,
    },
    { headers: { ...authHeader(), 'Content-Type': 'application/json' } }
  );
  // Update status in DB
  await Message.findOneAndUpdate({ messageId }, { status: 'read' });
}

// ─── 12. Upload local file to WhatsApp CDN ────────────────────────────────────
/**
 * Use this to get a media ID that you can reuse in sendImage/sendVideo/etc.
 * @param {string} filePath  - absolute or relative path to the file
 * @param {string} mimeType  - e.g. 'image/jpeg'
 * @returns {string}         - WhatsApp media ID
 */
export async function uploadMedia(filePath, mimeType) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', fs.createReadStream(filePath), {
    contentType: mimeType,
    filename: filePath.split('/').pop(),
  });

  const { data } = await axios.post(
    `${BASE_URL()}/media`,
    form,
    {
      headers: {
        ...authHeader(),
        ...form.getHeaders(),
      },
    }
  );
  return data.id; // media ID to use in send* functions
}
