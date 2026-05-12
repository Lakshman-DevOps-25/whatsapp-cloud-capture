/**
 * webhook.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /webhook  — Meta webhook verification challenge
 * POST /webhook  — Receive all inbound events and status updates
 *
 * Supported inbound message types handled:
 *   text, image, video, audio, document, sticker,
 *   location, contacts, button, interactive, reaction, unsupported
 */

import express from 'express';
import Message from '../models/Message.js';
import Contact from '../models/Contact.js';
import { downloadAndStoreMedia } from '../services/mediaService.js';
import { markRead } from '../services/whatsappService.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook  — Meta verification handshake
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    console.log('✅ Webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  console.warn('⚠️  Webhook verification failed — token mismatch');
  res.sendStatus(403);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook  — Inbound events
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  // IMPORTANT: Respond 200 immediately. If Meta doesn't get a 200 quickly
  // it will retry — which causes duplicate processing.
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value) continue;

        // ── Process incoming messages ─────────────────────────────────────
        for (const msg of value.messages || []) {
          await handleInboundMessage(msg, value);
        }

        // ── Process status updates ────────────────────────────────────────
        for (const status of value.statuses || []) {
          await handleStatusUpdate(status);
        }
      }
    }
  } catch (err) {
    console.error('❌ Webhook processing error:', err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Handle a single inbound message
// ─────────────────────────────────────────────────────────────────────────────
async function handleInboundMessage(msg, value) {
  const phoneNumberId = value.metadata?.phone_number_id;
  const contactInfo   = value.contacts?.find(c => c.wa_id === msg.from);
  const contactName   = contactInfo?.profile?.name || '';

  // ── Upsert contact ────────────────────────────────────────────────────────
  const isMedia = ['image','video','audio','document','sticker'].includes(msg.type);
  await Contact.findOneAndUpdate(
    { phone: msg.from },
    {
      $set:  { phone: msg.from, waId: msg.from, name: contactName, lastSeen: new Date() },
      $inc:  { messageCount: 1, ...(isMedia ? { mediaCount: 1 } : {}) },
      $setOnInsert: { firstSeen: new Date() },
    },
    { upsert: true, new: true }
  );

  // ── Build message document ────────────────────────────────────────────────
  const doc = {
    messageId:        msg.id,
    direction:        'inbound',
    from:             msg.from,
    to:               phoneNumberId,
    contactName,
    type:             msg.type,
    waTimestamp:      new Date(parseInt(msg.timestamp) * 1000),
    status:           'received',
    contextMessageId: msg.context?.id || null,
    rawPayload:       msg,
  };

  // ── Type-specific extraction ──────────────────────────────────────────────
  switch (msg.type) {

    case 'text':
      doc.body = msg.text?.body || '';
      console.log(`📩 TEXT  from ${msg.from}: ${doc.body}`);
      break;

    case 'image':
    case 'sticker': {
      const m = msg[msg.type];
      doc.media = {
        mediaId:  m.id,
        mimeType: m.mime_type,
        sha256:   m.sha256,
        caption:  m.caption || '',
      };
      doc.body = m.caption || '';
      console.log(`📸 ${msg.type.toUpperCase()} from ${msg.from} — id: ${m.id}`);

      // Download media asynchronously (don't block webhook response)
      downloadAndStoreMedia(m.id, m.mime_type)
        .then(stored => Message.findOneAndUpdate(
          { messageId: msg.id },
          { $set: { 'media.localPath': stored.localPath, 'media.minioKey': stored.minioKey,
                    'media.minioUrl': stored.minioUrl, 'media.fileSize': stored.fileSize,
                    'media.downloadedAt': stored.downloadedAt } }
        ))
        .catch(e => console.error(`❌ Media download failed (${m.id}):`, e.message));
      break;
    }

    case 'video': {
      const m = msg.video;
      doc.media = {
        mediaId:  m.id,
        mimeType: m.mime_type,
        sha256:   m.sha256,
        caption:  m.caption || '',
      };
      doc.body = m.caption || '';
      console.log(`🎥 VIDEO  from ${msg.from} — id: ${m.id}`);

      downloadAndStoreMedia(m.id, m.mime_type)
        .then(stored => Message.findOneAndUpdate(
          { messageId: msg.id },
          { $set: { 'media.localPath': stored.localPath, 'media.minioKey': stored.minioKey,
                    'media.minioUrl': stored.minioUrl, 'media.fileSize': stored.fileSize,
                    'media.downloadedAt': stored.downloadedAt } }
        ))
        .catch(e => console.error(`❌ Media download failed (${m.id}):`, e.message));
      break;
    }

    case 'audio': {
      const m = msg.audio;
      doc.media = {
        mediaId:  m.id,
        mimeType: m.mime_type,
        sha256:   m.sha256,
      };
      console.log(`🔊 AUDIO  from ${msg.from} — id: ${m.id} (voice: ${m.voice})`);

      downloadAndStoreMedia(m.id, m.mime_type)
        .then(stored => Message.findOneAndUpdate(
          { messageId: msg.id },
          { $set: { 'media.localPath': stored.localPath, 'media.minioKey': stored.minioKey,
                    'media.minioUrl': stored.minioUrl, 'media.fileSize': stored.fileSize,
                    'media.downloadedAt': stored.downloadedAt } }
        ))
        .catch(e => console.error(`❌ Media download failed (${m.id}):`, e.message));
      break;
    }

    case 'document': {
      const m = msg.document;
      doc.media = {
        mediaId:  m.id,
        mimeType: m.mime_type,
        sha256:   m.sha256,
        fileName: m.filename || '',
        caption:  m.caption  || '',
      };
      doc.body = m.caption || m.filename || '';
      console.log(`📄 DOC    from ${msg.from} — ${m.filename || m.id}`);

      downloadAndStoreMedia(m.id, m.mime_type, m.filename)
        .then(stored => Message.findOneAndUpdate(
          { messageId: msg.id },
          { $set: { 'media.localPath': stored.localPath, 'media.minioKey': stored.minioKey,
                    'media.minioUrl': stored.minioUrl, 'media.fileSize': stored.fileSize,
                    'media.downloadedAt': stored.downloadedAt } }
        ))
        .catch(e => console.error(`❌ Media download failed (${m.id}):`, e.message));
      break;
    }

    case 'location':
      doc.location = {
        latitude:  msg.location.latitude,
        longitude: msg.location.longitude,
        name:      msg.location.name    || '',
        address:   msg.location.address || '',
      };
      console.log(`📍 LOCATION from ${msg.from}: ${msg.location.latitude},${msg.location.longitude}`);
      break;

    case 'contacts':
      // Array of vCard-style contacts
      doc.body = JSON.stringify(msg.contacts);
      console.log(`👤 CONTACTS from ${msg.from}: ${msg.contacts?.length} contact(s)`);
      break;

    case 'button':
      // User tapped a template button
      doc.buttonReply = { id: msg.button?.payload, title: msg.button?.text };
      doc.body        = msg.button?.text || '';
      console.log(`🔘 BUTTON from ${msg.from}: "${msg.button?.text}"`);
      break;

    case 'interactive': {
      // User tapped a reply button or list item
      const ir = msg.interactive;
      if (ir?.type === 'button_reply') {
        doc.buttonReply = { id: ir.button_reply.id, title: ir.button_reply.title };
        doc.body        = ir.button_reply.title;
      } else if (ir?.type === 'list_reply') {
        doc.buttonReply = { id: ir.list_reply.id, title: ir.list_reply.title };
        doc.body        = ir.list_reply.title;
      }
      console.log(`🗂  INTERACTIVE from ${msg.from}: "${doc.body}"`);
      break;
    }

    case 'reaction':
      doc.reaction = { messageId: msg.reaction?.message_id, emoji: msg.reaction?.emoji };
      doc.body     = msg.reaction?.emoji || '';
      console.log(`😀 REACTION from ${msg.from}: ${msg.reaction?.emoji}`);
      break;

    default:
      doc.type = 'unsupported';
      doc.body = `[unsupported type: ${msg.type}]`;
      console.log(`❓ UNSUPPORTED type "${msg.type}" from ${msg.from}`);
  }

  // ── Save to MongoDB (upsert by messageId to avoid duplicates) ────────────
  await Message.findOneAndUpdate(
    { messageId: msg.id },
    { $set: doc },
    { upsert: true, new: true }
  );

  // ── Optionally auto-mark as read ─────────────────────────────────────────
  // await markRead(msg.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Handle a delivery/read status update
// ─────────────────────────────────────────────────────────────────────────────
async function handleStatusUpdate(status) {
  const update = { status: status.status };
  if (status.errors?.[0]) {
    update.errorCode    = status.errors[0].code?.toString();
    update.errorMessage = status.errors[0].title;
  }
  await Message.findOneAndUpdate({ messageId: status.id }, { $set: update });
  console.log(`📬 STATUS ${status.id} → ${status.status}`);
}

export default router;
