/**
 * webhook.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /webhook  — Meta verification
 * POST /webhook  — All inbound events (messages + status updates)
 *
 * INBOUND MEDIA FLOW (customer → business):
 *   1. Message saved to MongoDB immediately (with mediaId, mimeType)
 *   2. Media downloaded from WhatsApp CDN asynchronously
 *   3. Stored in MinIO (or local) — minioKey + minioUrl updated in MongoDB
 */

import express from 'express';
import Message from '../models/Message.js';
import Contact from '../models/Contact.js';
import { downloadAndStoreMedia } from '../services/mediaService.js';
import { markRead } from '../services/whatsappService.js';

const router = express.Router();

// ─── GET /webhook — Meta verification ────────────────────────────────────────
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  console.warn('⚠️  Webhook verify failed — token mismatch');
  res.sendStatus(403);
});

// ─── POST /webhook — Inbound events ──────────────────────────────────────────
router.post('/', async (req, res) => {
  // Always respond 200 immediately — Meta retries if it doesn't get one fast
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value) continue;

        for (const msg of value.messages || [])   await handleInbound(msg, value);
        for (const status of value.statuses || []) await handleStatus(status);
      }
    }
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Handle inbound message
// ─────────────────────────────────────────────────────────────────────────────
async function handleInbound(msg, value) {
  const phoneNumberId = value.metadata?.phone_number_id;
  const contactInfo   = value.contacts?.find(c => c.wa_id === msg.from);
  const contactName   = contactInfo?.profile?.name || '';
  const isMedia       = ['image','video','audio','document','sticker'].includes(msg.type);

  // ── Upsert contact ─────────────────────────────────────────────────────────
  try {
    await Contact.findOneAndUpdate(
      { phone: msg.from },
      {
        $set:         { phone: msg.from, waId: msg.from, name: contactName, lastSeen: new Date() },
        $inc:         { messageCount: 1, ...(isMedia ? { mediaCount: 1 } : {}) },
        $setOnInsert: { firstSeen: new Date() },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error(`⚠️  Contact upsert failed (${msg.from}):`, err.message);
  }

  // ── Build base document ────────────────────────────────────────────────────
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

  // ── Type-specific fields ───────────────────────────────────────────────────
  switch (msg.type) {

    case 'text':
      doc.body = msg.text?.body || '';
      console.log(`📩 TEXT    from ${msg.from}: ${doc.body}`);
      break;

    case 'image':
    case 'sticker': {
      const m = msg[msg.type];
      doc.media = { mediaId: m.id, mimeType: m.mime_type, sha256: m.sha256, caption: m.caption || '' };
      doc.body  = m.caption || '';
      console.log(`📸 ${msg.type.toUpperCase()} from ${msg.from} — mediaId: ${m.id}`);
      break;
    }

    case 'video': {
      const m = msg.video;
      doc.media = { mediaId: m.id, mimeType: m.mime_type, sha256: m.sha256, caption: m.caption || '' };
      doc.body  = m.caption || '';
      console.log(`🎥 VIDEO   from ${msg.from} — mediaId: ${m.id}`);
      break;
    }

    case 'audio': {
      const m = msg.audio;
      doc.media = { mediaId: m.id, mimeType: m.mime_type, sha256: m.sha256 };
      console.log(`🔊 AUDIO   from ${msg.from} — mediaId: ${m.id} voice=${m.voice}`);
      break;
    }

    case 'document': {
      const m = msg.document;
      doc.media = { mediaId: m.id, mimeType: m.mime_type, sha256: m.sha256, fileName: m.filename || '', caption: m.caption || '' };
      doc.body  = m.caption || m.filename || '';
      console.log(`📄 DOC     from ${msg.from} — ${m.filename || m.id}`);
      break;
    }

    case 'location':
      doc.location = { latitude: msg.location.latitude, longitude: msg.location.longitude, name: msg.location.name || '', address: msg.location.address || '' };
      console.log(`📍 LOCATION from ${msg.from}: ${msg.location.latitude},${msg.location.longitude}`);
      break;

    case 'contacts':
      doc.body = JSON.stringify(msg.contacts);
      console.log(`👤 CONTACTS from ${msg.from}: ${msg.contacts?.length} contact(s)`);
      break;

    case 'button':
      doc.buttonReply = { id: msg.button?.payload, title: msg.button?.text };
      doc.body        = msg.button?.text || '';
      console.log(`🔘 BUTTON  from ${msg.from}: "${msg.button?.text}"`);
      break;

    case 'interactive': {
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
      doc.body = `[unsupported: ${msg.type}]`;
      console.log(`❓ UNSUPPORTED "${msg.type}" from ${msg.from}`);
  }

  // ── Save to MongoDB immediately ────────────────────────────────────────────
  try {
    await Message.findOneAndUpdate(
      { messageId: msg.id },
      { $set: doc },
      { upsert: true, new: true }
    );
    console.log(`✅ DB saved inbound ${msg.type} from ${msg.from} [${msg.id}]`);
  } catch (err) {
    console.error(`❌ DB save failed (${msg.id}):`, err.message);
    return; // Don't proceed to media download if DB save failed
  }

  // ── Download + store media in MinIO/local (async, after DB save) ───────────
  if (isMedia && doc.media?.mediaId) {
    downloadAndStoreMedia(doc.media.mediaId, doc.media.mimeType, doc.media.fileName || null)
      .then(async (stored) => {
        // Build the storage update — only set fields that exist in the result
        const mediaUpdate = {};
        if (stored.localPath)    mediaUpdate['media.localPath']    = stored.localPath;
        if (stored.minioKey)     mediaUpdate['media.minioKey']     = stored.minioKey;
        if (stored.minioUrl)     mediaUpdate['media.minioUrl']     = stored.minioUrl;
        if (stored.fileSize)     mediaUpdate['media.fileSize']     = stored.fileSize;
        if (stored.downloadedAt) mediaUpdate['media.downloadedAt'] = stored.downloadedAt;

        if (Object.keys(mediaUpdate).length > 0) {
          await Message.findOneAndUpdate(
            { messageId: msg.id },
            { $set: mediaUpdate }
          );
          console.log(`✅ DB updated media storage for [${msg.id}]:`, stored.minioUrl || stored.localPath);
        }
      })
      .catch(err => console.error(`❌ Media download/store failed (${doc.media.mediaId}):`, err.message));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handle status update (sent → delivered → read → failed)
// ─────────────────────────────────────────────────────────────────────────────
async function handleStatus(status) {
  try {
    const update = { status: status.status };
    if (status.errors?.[0]) {
      update.errorCode    = status.errors[0].code?.toString();
      update.errorMessage = status.errors[0].title;
    }
    await Message.findOneAndUpdate({ messageId: status.id }, { $set: update });
    console.log(`📬 STATUS [${status.id}] → ${status.status}`);
  } catch (err) {
    console.error(`⚠️  Status update failed (${status.id}):`, err.message);
  }
}

export default router;
