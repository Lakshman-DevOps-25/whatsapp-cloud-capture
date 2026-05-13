/**
 * webhook.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /webhook  — Meta verification
 * POST /webhook  — All inbound events (messages + status updates)
 *
 * DIRECTION DETECTION:
 *   Meta sends webhook events for BOTH directions:
 *   - customer → business : value.messages[] where msg.from = customer phone
 *   - business → customer : value.statuses[]  for API-sent messages
 *                           value.messages[]  echo when sent from WA app/web
 *
 * FROM / TO stored in MongoDB are always REAL phone numbers (E.164):
 *   inbound:  from = customer phone,       to = WA_BUSINESS_PHONE
 *   outbound: from = WA_BUSINESS_PHONE,    to = customer phone (msg.to)
 */

import express from 'express';
import Message from '../models/Message.js';
import Contact from '../models/Contact.js';
import { downloadAndStoreMedia } from '../services/mediaService.js';

const router = express.Router();

// Our business phone number (real number, not phone number ID)
const MY_PHONE = () => (process.env.WA_BUSINESS_PHONE || process.env.WA_PHONE_NUMBER_ID || '').trim();

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

// ─── POST /webhook ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  res.sendStatus(200);
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
    console.error('❌ Webhook error:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Handle a single message event
// ─────────────────────────────────────────────────────────────────────────────
async function handleMessage(msg, value) {
  const phoneNumberId = value.metadata?.phone_number_id;   // e.g. "123456789012345" (ID, not phone)
  const myPhone       = MY_PHONE();                         // e.g. "919000000000"    (real phone)

  // ── Direction detection ──────────────────────────────────────────────────
  // msg.from = sender's real phone number (E.164 always)
  // msg.to   = recipient's real phone number (E.164 always) — present in echo events
  //
  // Outbound echo: msg.from matches our business phone number OR phone number ID
  const isOutbound = msg.from === myPhone || msg.from === phoneNumberId;
  const direction  = isOutbound ? 'outbound' : 'inbound';

  // ── Real phone numbers for from/to ───────────────────────────────────────
  // inbound:  from=customer,  to=our business phone
  // outbound: from=our phone, to=customer (msg.to is the recipient real phone)
  const fromPhone     = isOutbound ? myPhone    : msg.from;
  const toPhone       = isOutbound ? (msg.to || '') : myPhone;
  const customerPhone = isOutbound ? toPhone    : fromPhone;

  const isMedia     = ['image','video','audio','document','sticker'].includes(msg.type);
  const contactInfo = value.contacts?.find(c => c.wa_id === msg.from);
  const contactName = contactInfo?.profile?.name || '';

  console.log(`📨 ${direction.toUpperCase()} | type=${msg.type} | from=${fromPhone} | to=${toPhone}`);

  // ── Upsert contact (always the customer side) ─────────────────────────────
  if (customerPhone) {
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
      console.error(`⚠️  Contact upsert(${customerPhone}):`, err.message);
    }
  }

  // ── Build document ────────────────────────────────────────────────────────
  const doc = {
    messageId:        msg.id,
    direction,
    from:             fromPhone,        // always a real phone number
    to:               toPhone,          // always a real phone number
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
      console.log(`   🔊 mediaId=${m.id}`);
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
        doc.buttonReply = { id: ir.button_reply.id, title: ir.button_reply.title };
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
      console.log(`   ❓ "${msg.type}"`);
  }

  // ── Save to MongoDB ───────────────────────────────────────────────────────
  try {
    const saved = await Message.findOneAndUpdate(
      { messageId: msg.id },
      { $set: doc },
      { upsert: true, new: true }
    );
    console.log(`   ✅ DB saved ${direction} from=${fromPhone} to=${toPhone} [${msg.id}]`);
  } catch (err) {
    console.error(`   ❌ DB save failed (${msg.id}):`, err.message);
    return;
  }

  // ── Download + store media ────────────────────────────────────────────────
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
          console.log(`   ✅ Media stored: ${stored.minioUrl || stored.localPath}`);
        }
      })
      .catch(err => console.error(`   ❌ Media store failed (${doc.media.mediaId}):`, err.message));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handle status update
// ─────────────────────────────────────────────────────────────────────────────
async function handleStatus(status) {
  try {
    const update = { status: status.status };
    if (status.errors?.[0]) {
      update.errorCode    = status.errors[0].code?.toString();
      update.errorMessage = status.errors[0].title;
    }
    const updated = await Message.findOneAndUpdate({ messageId: status.id }, { $set: update });
    if (updated) console.log(`📬 STATUS [${status.id}] → ${status.status}`);
  } catch (err) {
    console.error(`⚠️  Status update(${status.id}):`, err.message);
  }
}

export default router;
