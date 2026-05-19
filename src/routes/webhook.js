/**
 * webhook.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /webhook  — Meta verification
 * POST /webhook  — Inbound events from Meta
 *
 * IMPORTANT — HOW META WEBHOOKS WORK:
 *
 *   value.messages[]  → ALWAYS customer → business (inbound)
 *                        Meta only puts customer-sent messages here.
 *                        Messages sent via API never appear in messages[].
 *
 *   value.statuses[]  → Delivery receipts for business → customer messages
 *                        (sent, delivered, read, failed)
 *                        These update the outbound records already saved
 *                        by whatsappService.js saveOutbound().
 *
 * So this file ONLY handles:
 *   1. Inbound messages  (customer → business) → save to MongoDB + MinIO
 *   2. Status updates    (delivery receipts)   → update existing MongoDB record
 *
 * Outbound messages (business → customer) are saved by whatsappService.js
 * BEFORE the message is sent to Meta. Webhook only updates their status.
 */

import express  from 'express';
import mongoose from 'mongoose';
import Message  from '../models/Message.js';
import Contact  from '../models/Contact.js';
import { downloadAndStoreMedia } from '../services/mediaService.js';

const router = express.Router();

const MY_PHONE = () => (process.env.WA_BUSINESS_PHONE || '').trim();

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
  res.sendStatus(200); // respond immediately

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        console.log("Value after webhook post: ", value);
        if (!value) continue;

        // messages[] = inbound from customer (direction always = inbound)
        for (const msg of value.messages || []) {
          await handleInbound(msg, value);
        }

        // statuses[] = delivery receipts for outbound messages sent via API
        for (const status of value.statuses || []) {
          await handleStatus(status);
        }
      }
    }
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INBOUND: customer → business
// All messages[] events are from customers. direction = inbound always.
// ─────────────────────────────────────────────────────────────────────────────
async function handleInbound(msg, value) {
  const myPhone     = MY_PHONE();
  const fromPhone   = msg.from;           // customer's real phone number (E.164)
  const toPhone     = myPhone;            // our business phone number
  const isMedia     = ['image','video','audio','document','sticker'].includes(msg.type);
  const contactInfo = value.contacts?.find(c => c.wa_id === msg.from);
  const contactName = contactInfo?.profile?.name || '';

  console.log(`📩 INBOUND | type=${msg.type} | from=${fromPhone} | to=${toPhone}`);

  // ── Upsert customer contact ───────────────────────────────────────────────
  try {
    await Contact.findOneAndUpdate(
      { phone: fromPhone },
      {
        $set:         { phone: fromPhone, waId: fromPhone, name: contactName, lastSeen: new Date() },
        $inc:         { messageCount: 1, ...(isMedia ? { mediaCount: 1 } : {}) },
        $setOnInsert: { firstSeen: new Date() },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error(`⚠️  Contact upsert(${fromPhone}):`, err.message);
  }

  // ── Build document ────────────────────────────────────────────────────────
  const doc = {
    messageId:        msg.id,
    direction:        'inbound',
    from:             fromPhone,
    to:               toPhone,
    contactName,
    type:             msg.type,
    waTimestamp:      new Date(parseInt(msg.timestamp) * 1000),
    status:           'received',
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
  }

  // ── Save to MongoDB via native driver ────────────────────────────────────
  console.log(`   💾 Saving: messageId=${msg.id} type=${doc.type} direction=inbound`);
  try {
    const now = new Date();
    const { default: Msg } = await import('../models/Message.js');
    await Msg.collection.updateOne(
      { messageId: msg.id },
      { $set: { ...doc, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );
    console.log(`   ✅ DB saved inbound: type=${doc.type} from=${doc.from} to=${doc.to}`);
  } catch (err) {
    console.error(`   ❌ DB save failed (${msg.id}):`, err.message);
    return;
  }

  // ── Download + store media in MinIO/local (runs async after webhook 200 response) ──
  if (isMedia && doc.media?.mediaId) {
    storeInboundMedia(msg.id, doc.media.mediaId, doc.media.mimeType, doc.media.fileName || null);
  }
}

async function storeInboundMedia(messageId, mediaId, mimeType, fileName) {
  console.log(`\n   📥 Storing inbound media: mediaId=${mediaId}`);
  try {
    const stored = await downloadAndStoreMedia(mediaId, mimeType, fileName);

    const update = {};
    if (stored.localPath)    update['media.localPath']    = stored.localPath;
    if (stored.minioKey)     update['media.minioKey']     = stored.minioKey;
    if (stored.minioUrl)     update['media.minioUrl']     = stored.minioUrl;
    if (stored.fileSize)     update['media.fileSize']     = stored.fileSize;
    if (stored.downloadedAt) update['media.downloadedAt'] = stored.downloadedAt;

    if (Object.keys(update).length > 0) {
      const { default: Msg } = await import('../models/Message.js');
      await Msg.collection.updateOne({ messageId }, { $set: update });
      console.log(`   ✅ Inbound media stored and DB updated: ${stored.minioUrl || stored.localPath}`);
    }
  } catch (err) {
    console.error(`   ❌ Inbound media store FAILED for mediaId=${mediaId}: ${err.message}`);
    console.error(`      Stack: ${err.stack}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS UPDATE: delivery receipt for outbound message
// Only updates existing records — never creates placeholders.
// sendAndSave() is the sole writer of outbound records.
// ─────────────────────────────────────────────────────────────────────────────
async function handleStatus(status) {
  console.log("Status.id: ", status.id);
  try {
    const update = { status: status.status };
    if (status.errors?.[0]) {
      update.errorCode    = status.errors[0].code?.toString();
      update.errorMessage = status.errors[0].title;
    }
    
    const { default: Msg } = await import('../models/Message.js');
    const result = await Msg.collection.updateOne(
      { messageId: status.id },
      { $set: { ...update, updatedAt: new Date() } }
    );
    console.log("Result: ", $result);

    if (result.matchedCount > 0) {
      console.log(`📬 STATUS [${status.id.slice(-10)}] → ${status.status}`);
    } else if (status.status === 'sent') {
      // status=sent always arrives ~50ms before saveMessage completes (~200ms)
      // Retry after 1.5s — saveMessage will have written the record by then
      setTimeout(async () => {
        try {
          const r = await col.updateOne(
            { messageId: status.id },
            { $set: { ...update, updatedAt: new Date() } }
          );
          if (r.matchedCount > 0) {
            console.log(`📬 STATUS [${status.id.slice(-10)}] → sent (applied on retry)`);
          }
        } catch (_) {}
      }, 1500);
    } else {
      console.log(`📬 STATUS [${status.id.slice(-10)}] → ${status.status} (record not found)`);
    }
  } catch (err) {
    console.error(`⚠️  Status update(${status.id}): ${err.message}`);
  }
}

export default router;
