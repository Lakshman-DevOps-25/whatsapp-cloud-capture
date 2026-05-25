/**
 * webhook.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /webhook  — Meta verification
 * POST /webhook  — Inbound events from Meta
 */

import express  from 'express';
import mongoose from 'mongoose';
import Contact  from '../models/Contact.js';
import { downloadAndStoreMedia } from '../services/mediaService.js';

const router   = express.Router();
const MY_PHONE = () => (process.env.WA_BUSINESS_PHONE || '').trim();

// ── Always use mongoose.connection.db — guaranteed after connectDB() ──────────
const col = () => mongoose.connection.db.collection('messages');

// ─── GET /webhook — Meta verification ────────────────────────────────────────
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ─── POST /webhook — inbound events ──────────────────────────────────────────
router.post('/', express.json(), async (req, res) => {
  res.sendStatus(200); // always ACK immediately

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        if (change.field !== 'messages') continue;
        const value = change.value;

        // Inbound messages (customer → business)
        for (const msg of (value.messages || [])) {
          await handleInbound(msg, value).catch(e =>
            console.error('⚠️  handleInbound error:', e.message)
          );
        }

        // Status updates (delivery receipts for outbound)
        for (const status of (value.statuses || [])) {
          await handleStatus(status).catch(e =>
            console.error('⚠️  handleStatus error:', e.message)
          );
        }
      }
    }
  } catch (err) {
    console.error('⚠️  Webhook processing error:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INBOUND — customer → business
// ─────────────────────────────────────────────────────────────────────────────
async function handleInbound(msg, value) {
  const from    = msg.from;
  const to      = MY_PHONE() || value.metadata?.display_phone_number || '';
  const now     = new Date();
  const ts      = msg.timestamp ? new Date(parseInt(msg.timestamp) * 1000) : now;

  console.log(`\n📩 INBOUND ${msg.type?.toUpperCase()} from=${from} to=${to}`);

  // ── Build document ─────────────────────────────────────────────────────────
  const doc = {
    messageId:   msg.id,
    direction:   'inbound',
    from,
    to,
    type:        msg.type,
    status:      'received',
    waTimestamp: ts,
  };

  // ── Extract content by type ────────────────────────────────────────────────
  if (msg.type === 'text') {
    doc.body = msg.text?.body || '';
  }
  if (['image','video','audio','document','sticker'].includes(msg.type)) {
    const m = msg[msg.type] || {};
    doc.media = {
      mediaId:  m.id,
      mimeType: m.mime_type,
      sha256:   m.sha256,
      fileName: m.filename || null,
      caption:  m.caption  || null,
    };
  }
  if (msg.type === 'location') {
    doc.location = {
      latitude:  msg.location?.latitude,
      longitude: msg.location?.longitude,
      name:      msg.location?.name    || '',
      address:   msg.location?.address || '',
    };
  }
  if (msg.type === 'reaction') {
    doc.reaction = { messageId: msg.reaction?.message_id, emoji: msg.reaction?.emoji };
  }
  if (msg.type === 'button') {
    doc.buttonReply = { text: msg.button?.text, payload: msg.button?.payload };
  }
  if (msg.type === 'interactive') {
    const ir = msg.interactive;
    doc.buttonReply = ir?.button_reply || ir?.list_reply || null;
    doc.body        = doc.buttonReply?.title || '';
  }
  if (msg.type === 'contacts') {
    doc.rawPayload = msg.contacts;
  }

  // ── Save to MongoDB ────────────────────────────────────────────────────────
  try {
    await col().updateOne(
      { messageId: msg.id },
      { $set: { ...doc, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );
    console.log(`   ✅ Inbound saved: type=${doc.type} from=${from}`);
  } catch (err) {
    console.error(`   ❌ Inbound DB save failed (${msg.id}):`, err.message);
    return;
  }

  // ── Upsert contact ─────────────────────────────────────────────────────────
  try {
    await Contact.findOneAndUpdate(
      { phone: from },
      {
        $set:         { phone: from, waId: from, lastSeen: now },
        $inc:         { messageCount: 1 },
        $setOnInsert: { firstSeen: now },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error(`   ⚠️  upsertContact(${from}):`, err.message);
  }

  // ── Download + store media asynchronously ─────────────────────────────────
  if (doc.media?.mediaId) {
    storeInboundMedia(msg.id, doc.media.mediaId, doc.media.mimeType, doc.media.fileName)
      .catch(e => console.error(`   ❌ storeInboundMedia error: ${e.message}`));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STORE INBOUND MEDIA — download from WA CDN → MinIO
// ─────────────────────────────────────────────────────────────────────────────
async function storeInboundMedia(messageId, mediaId, mimeType, fileName) {
  if (!process.env.WA_ACCESS_TOKEN) {
    console.error(`   ❌ WA_ACCESS_TOKEN not set — cannot download media ${mediaId}`);
    return;
  }
  try {
    const stored = await downloadAndStoreMedia(mediaId, mimeType, null);
    if (stored && (stored.minioUrl || stored.localPath)) {
      const update = {};
      if (stored.minioKey)     update['media.minioKey']     = stored.minioKey;
      if (stored.minioUrl)     update['media.minioUrl']     = stored.minioUrl;
      if (stored.localPath)    update['media.localPath']    = stored.localPath;
      if (stored.fileSize)     update['media.fileSize']     = stored.fileSize;
      if (stored.fileName)     update['media.fileName']     = stored.fileName || fileName;
      if (stored.mimeType)     update['media.mimeType']     = stored.mimeType;
      if (stored.downloadedAt) update['media.downloadedAt'] = stored.downloadedAt;
      await col().updateOne({ messageId }, { $set: update });
      console.log(`   ✅ Inbound media stored: ${stored.minioUrl || stored.localPath}`);
    }
  } catch (err) {
    console.error(`   ❌ Failed to download media ${mediaId}: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS UPDATE — delivery receipts for outbound messages
// ─────────────────────────────────────────────────────────────────────────────
async function handleStatus(status) {
  try {
    const update = { status: status.status, updatedAt: new Date() };
    if (status.errors?.[0]) {
      update.errorCode    = status.errors[0].code?.toString();
      update.errorMessage = status.errors[0].title;
    }

    const result = await col().updateOne(
      { messageId: status.id },
      { $set: update }
    );

    if (result.matchedCount > 0) {
      console.log(`📬 STATUS [${status.id.slice(-10)}] → ${status.status}`);
    } else if (status.status === 'sent') {
      // status=sent fires ~50ms before saveMessage completes — retry after 1.5s
      setTimeout(async () => {
        try {
          const r = await col().updateOne(
            { messageId: status.id },
            { $set: update }
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
