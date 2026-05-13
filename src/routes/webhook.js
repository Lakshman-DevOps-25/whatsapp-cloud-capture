/**
 * webhook.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /webhook  — Meta verification
 * POST /webhook  — All inbound events (messages + status updates)
 *
 * DIRECTION DETECTION:
 *   Meta sends webhook for BOTH directions:
 *   - customer → business : value.messages[] where msg.from = customer phone
 *   - business → customer : value.statuses[] for API-sent messages
 *                           value.messages[] echo when sent from WA app/web
 *
 *   We compare msg.from against WA_PHONE_NUMBER_ID to detect direction.
 *   If msg.from matches our number → outbound echo → save as direction=outbound
 *   Otherwise → direction=inbound
 */

import express from 'express';
import Message from '../models/Message.js';
import Contact from '../models/Contact.js';
import { downloadAndStoreMedia } from '../services/mediaService.js';

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
  console.warn('⚠️  Webhook verify failed');
  res.sendStatus(403);
});

// ─── POST /webhook — Inbound events ──────────────────────────────────────────
router.post('/', async (req, res) => {
  res.sendStatus(200); // always respond fast

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value) continue;
        for (const msg    of value.messages  || []) await handleMessage(msg, value);
        for (const status of value.statuses  || []) await handleStatus(status);
      }
    }
  } catch (err) {
    console.error('❌ Webhook processing error:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Handle a single message event
// ─────────────────────────────────────────────────────────────────────────────
async function handleMessage(msg, value) {
  const phoneNumberId = value.metadata?.phone_number_id;
  const myPhoneId     = (process.env.WA_PHONE_NUMBER_ID || '').trim();

  // ── Direction detection ──────────────────────────────────────────────────
  // msg.from is sender phone in E.164 (e.g. "919876543210")
  // If sender IS our business number → outbound echo (sent from WA app/web)
  // Otherwise → inbound from customer
  const isOutbound  = (msg.from === myPhoneId) || (msg.from === phoneNumberId);
  const direction   = isOutbound ? 'outbound' : 'inbound';
  const fromPhone   = isOutbound ? myPhoneId  : msg.from;
  const toPhone     = isOutbound ? (msg.to || '') : phoneNumberId;
  const isMedia     = ['image','video','audio','document','sticker'].includes(msg.type);

  console.log(`📨 ${direction.toUpperCase()} | type=${msg.type} | from=${fromPhone} | to=${toPhone}`);

  // ── Upsert contact (customer side only) ──────────────────────────────────
  const contactInfo = value.contacts?.find(c => c.wa_id === msg.from);
  const contactName = contactInfo?.profile?.name || '';
  const customerPhone = isOutbound ? toPhone : fromPhone;

  try {
    await Contact.findOneAndUpdate(
      { phone: customerPhone },
      {
        $set:         { phone: customerPhone, waId: customerPhone, name: contactName, lastSeen: new Date() },
        $inc:         { messageCount: 1, ...(isMedia ? { mediaCount: 1 } : {}) },
        $setOnInsert: { firstSeen: new Date() },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error(`⚠️  Contact upsert failed (${customerPhone}):`, err.message);
  }

  // ── Build base document ───────────────────────────────────────────────────
  const doc = {
    messageId:        msg.id,
    direction,
    from:             fromPhone,
    to:               toPhone,
    contactName,
    type:             msg.type,
    waTimestamp:      new Date(parseInt(msg.timestamp) * 1000),
    status:           isOutbound ? 'sent' : 'received',
    contextMessageId: msg.context?.id || null,
    rawPayload:       msg,
  };

  // ── Type-specific fields ──────────────────────────────────────────────────
  switch (msg.type) {

    case 'text':
      doc.body = msg.text?.body || '';
      console.log(`   💬 "${doc.body}"`);
      break;

    case 'image':
    case 'sticker': {
      const m = msg[msg.type];
      doc.media = { mediaId: m.id, mimeType: m.mime_type, sha256: m.sha256, caption: m.caption || '' };
      doc.body  = m.caption || '';
      console.log(`   🖼  mediaId=${m.id}`);
      break;
    }

    case 'video': {
      const m = msg.video;
      doc.media = { mediaId: m.id, mimeType: m.mime_type, sha256: m.sha256, caption: m.caption || '' };
      doc.body  = m.caption || '';
      console.log(`   🎥 mediaId=${m.id}`);
      break;
    }

    case 'audio': {
      const m = msg.audio;
      doc.media = { mediaId: m.id, mimeType: m.mime_type, sha256: m.sha256 };
      console.log(`   🔊 mediaId=${m.id} voice=${m.voice}`);
      break;
    }

    case 'document': {
      const m = msg.document;
      doc.media = { mediaId: m.id, mimeType: m.mime_type, sha256: m.sha256, fileName: m.filename || '', caption: m.caption || '' };
      doc.body  = m.caption || m.filename || '';
      console.log(`   📄 ${m.filename || m.id}`);
      break;
    }

    case 'location':
      doc.location = { latitude: msg.location.latitude, longitude: msg.location.longitude, name: msg.location.name || '', address: msg.location.address || '' };
      console.log(`   📍 ${msg.location.latitude},${msg.location.longitude}`);
      break;

    case 'contacts':
      doc.body = JSON.stringify(msg.contacts);
      console.log(`   👤 ${msg.contacts?.length} contact(s)`);
      break;

    case 'button':
      doc.buttonReply = { id: msg.button?.payload, title: msg.button?.text };
      doc.body        = msg.button?.text || '';
      console.log(`   🔘 "${msg.button?.text}"`);
      break;

    case 'interactive': {
      const ir = msg.interactive;
      if (ir?.type === 'button_reply') {
        doc.buttonReply = { id: ir.button_reply.id,  title: ir.button_reply.title };
        doc.body        = ir.button_reply.title;
      } else if (ir?.type === 'list_reply') {
        doc.buttonReply = { id: ir.list_reply.id, title: ir.list_reply.title };
        doc.body        = ir.list_reply.title;
      }
      console.log(`   🗂  "${doc.body}"`);
      break;
    }

    case 'reaction':
      doc.reaction = { messageId: msg.reaction?.message_id, emoji: msg.reaction?.emoji };
      doc.body     = msg.reaction?.emoji || '';
      console.log(`   😀 ${msg.reaction?.emoji}`);
      break;

    default:
      doc.type = 'unsupported';
      doc.body = `[unsupported: ${msg.type}]`;
      console.log(`   ❓ unsupported type "${msg.type}"`);
  }

  // ── Save to MongoDB ───────────────────────────────────────────────────────
  try {
    const saved = await Message.findOneAndUpdate(
      { messageId: msg.id },
      { $set: doc },
      { upsert: true, new: true }
    );
    console.log(`   ✅ DB saved ${direction} ${msg.type} [${msg.id}] _id=${saved._id}`);
  } catch (err) {
    console.error(`   ❌ DB save failed (${msg.id}):`, err.message);
    return;
  }

  // ── Download + store media in MinIO/local ─────────────────────────────────
  if (isMedia && doc.media?.mediaId) {
    downloadAndStoreMedia(doc.media.mediaId, doc.media.mimeType, doc.media.fileName || null)
      .then(async (stored) => {
        const mediaUpdate = {};
        if (stored.localPath)    mediaUpdate['media.localPath']    = stored.localPath;
        if (stored.minioKey)     mediaUpdate['media.minioKey']     = stored.minioKey;
        if (stored.minioUrl)     mediaUpdate['media.minioUrl']     = stored.minioUrl;
        if (stored.fileSize)     mediaUpdate['media.fileSize']     = stored.fileSize;
        if (stored.downloadedAt) mediaUpdate['media.downloadedAt'] = stored.downloadedAt;

        if (Object.keys(mediaUpdate).length > 0) {
          await Message.findOneAndUpdate({ messageId: msg.id }, { $set: mediaUpdate });
          console.log(`   ✅ MinIO/local updated for [${msg.id}]:`, stored.minioUrl || stored.localPath);
        }
      })
      .catch(err => console.error(`   ❌ Media store failed (${doc.media.mediaId}):`, err.message));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handle delivery/read status update
// ─────────────────────────────────────────────────────────────────────────────
async function handleStatus(status) {
  try {
    const update = { status: status.status };
    if (status.errors?.[0]) {
      update.errorCode    = status.errors[0].code?.toString();
      update.errorMessage = status.errors[0].title;
    }
    const updated = await Message.findOneAndUpdate(
      { messageId: status.id },
      { $set: update }
    );
    if (updated) {
      console.log(`📬 STATUS [${status.id}] → ${status.status}`);
    }
  } catch (err) {
    console.error(`⚠️  Status update failed (${status.id}):`, err.message);
  }
}

export default router;
