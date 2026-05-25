/**
 * messages.js — REST API
 */

import express   from 'express';
import { handleTokenStatus, handleRefreshToken, handleUpdateToken } from '../services/tokenService.js';
import { getAllConfig, saveConfigToDB, MANAGED_KEYS } from '../services/configService.js';
import mongoose  from 'mongoose';
import multer    from 'multer';
import path      from 'path';
import os        from 'os';
import { mkdirSync } from 'fs';
import Message   from '../models/Message.js';
import Contact   from '../models/Contact.js';
import {
  sendText, sendImage, sendVideo, sendAudio,
  sendDocument, sendSticker, sendLocation,
  sendTemplate, sendButtons, sendList, uploadMedia, markRead,
} from '../services/whatsappService.js';

const router = express.Router();

// ── Multer — use OS temp dir (works on Railway, Docker, everywhere) ───────────
// os.tmpdir() is always writable: /tmp on Linux/Railway, C:\Temp on Windows
const TEMP_DIR = path.join(os.tmpdir(), 'wa_uploads');
try { mkdirSync(TEMP_DIR, { recursive: true }); } catch (e) { /* already exists */ }

console.log(`📁 Multer temp dir: ${TEMP_DIR}`);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      mkdirSync(TEMP_DIR, { recursive: true });
      cb(null, TEMP_DIR);
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 64 * 1024 * 1024 }, // 64 MB
});

// ─────────────────────────────────────────────────────────────────────────────
// READ ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/messages
router.get('/', async (req, res) => {
  try {
    const page   = Math.max(parseInt(req.query.page  || '1'), 1);
    const limit  = Math.min(parseInt(req.query.limit || '50'), 200);
    const filter = {};
    if (req.query.type)      filter.type = req.query.type;
    if (req.query.direction) filter.direction = req.query.direction;
    if (req.query.status)    filter.status    = req.query.status;
    const [messages, total] = await Promise.all([
      Message.find(filter).sort({ waTimestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Message.countDocuments(filter),
    ]);
    res.json({ total, page, limit, messages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/search  — Search messages across all fields
//
// Query params (all optional, combinable):
//   q          full-text search across body, contactName, from, to
//   phone      search by phone number (from OR to) — partial match
//   from       exact or partial sender phone
//   to         exact or partial recipient phone
//   body       partial text in message body
//   type       message type: text/image/video/audio/document etc.
//   direction  inbound / outbound
//   status     sent/delivered/read/received/failed
//   from_date  ISO date start  e.g. 2024-01-01
//   to_date    ISO date end    e.g. 2024-12-31
//   has_media  true → only messages with media files
//   has_minio  true → only messages with minioUrl stored
//   page       default 1
//   limit      default 50, max 200
//
// Examples:
//   GET /api/search?q=hello
//   GET /api/search?phone=919876543210
//   GET /api/search?body=invoice&type=document
//   GET /api/search?direction=outbound&status=read
//   GET /api/search?from_date=2024-01-01&to_date=2024-12-31
//   GET /api/search?has_media=true&direction=inbound
// ─────────────────────────────────────────────────────────────────────────────
router.get('/search', async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page  || '1'), 1);
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const skip  = (page - 1) * limit;

    const filter = {};

    // ── Full-text search across multiple fields ───────────────────────────────
    if (req.query.q) {
      const regex = { $regex: req.query.q, $options: 'i' };
      filter.$or = [
        { body:        regex },
        { contactName: regex },
        { from:        regex },
        { to:          regex },
        { 'media.fileName': regex },
        { 'media.caption':  regex },
      ];
    }

    // ── Phone number search (from OR to) ─────────────────────────────────────
    if (req.query.phone) {
      const phoneRegex = { $regex: req.query.phone, $options: 'i' };
      // If $or already set from q, merge with $and
      if (filter.$or) {
        filter.$and = [
          { $or: filter.$or },
          { $or: [{ from: phoneRegex }, { to: phoneRegex }] },
        ];
        delete filter.$or;
      } else {
        filter.$or = [{ from: phoneRegex }, { to: phoneRegex }];
      }
    }

    // ── Individual field filters ──────────────────────────────────────────────
    if (req.query.from)      filter.from      = { $regex: req.query.from,  $options: 'i' };
    if (req.query.to)        filter.to        = { $regex: req.query.to,    $options: 'i' };
    if (req.query.body)      filter.body      = { $regex: req.query.body,  $options: 'i' };
    if (req.query.type)      filter.type      = req.query.type;
    if (req.query.direction) filter.direction = req.query.direction;
    if (req.query.status)    filter.status    = req.query.status;

    // ── Date range ────────────────────────────────────────────────────────────
    if (req.query.from_date || req.query.to_date) {
      filter.waTimestamp = {};
      if (req.query.from_date) filter.waTimestamp.$gte = new Date(req.query.from_date);
      if (req.query.to_date)   filter.waTimestamp.$lte = new Date(req.query.to_date + 'T23:59:59.999Z');
    }

    // ── Media filters ─────────────────────────────────────────────────────────
    if (req.query.has_media === 'true') filter['media.mediaId'] = { $exists: true };
    if (req.query.has_minio === 'true') filter['media.minioUrl'] = { $exists: true };

    const [messages, total] = await Promise.all([
      Message.find(filter)
        .sort({ waTimestamp: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Message.countDocuments(filter),
    ]);

    res.json({
      total,
      page,
      limit,
      pages:    Math.ceil(total / limit),
      query:    req.query,
      messages,
    });
  } catch (err) {
    console.error('[GET /api/search] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/outbound
router.get('/outbound', async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page  || '1'), 1);
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const filter = { direction: 'outbound' };
    if (req.query.type)   filter.type = req.query.type;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.to)     filter.to     = req.query.to;
    const [messages, total] = await Promise.all([
      Message.find(filter).sort({ waTimestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Message.countDocuments(filter),
    ]);
    res.json({ total, page, limit, messages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/messages/media
router.get('/media', async (req, res) => {
  try {
    const filter = { 'media.mediaId': { $exists: true } };
    if (req.query.type)      filter.type = req.query.type;
    if (req.query.direction) filter.direction = req.query.direction;
    const messages = await Message.find(filter).sort({ waTimestamp: -1 }).limit(100).lean();
    res.json({ count: messages.length, messages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/messages/contact/:phone
// Returns full conversation thread between business and this customer phone number.
// Messages from BOTH directions sorted oldest → newest (like WhatsApp chat view).
router.get('/contact/:phone', async (req, res) => {
  try {
    // Decode phone correctly — handles +91... passed as %2B91 or plain +91
    const rawPhone = (req.params.phone || '').replace(/\+/g, '%2B');
    const phone    = decodeURIComponent(rawPhone).trim();
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    const page    = Math.max(parseInt(req.query.page  || '1'), 1);
    const limit   = Math.min(parseInt(req.query.limit || '100'), 500);
    const myPhone = (process.env.WA_BUSINESS_PHONE || '').trim();

    console.log(`[GET /contact/:phone] phone=${phone}`);

    // Fetch thread + contact + total + mark all inbound as read — all in parallel
    const filter = { $or: [{ from: phone }, { to: phone }] };

    const [messages, contact, total] = await Promise.all([
      Message.find(filter)
        .sort({ waTimestamp: 1 })   // oldest first — WhatsApp chat order
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Contact.findOne({ phone }).lean(),
      Message.countDocuments(filter),
      // Mark all unread inbound messages from this contact as read
      Message.updateMany(
        { from: phone, direction: 'inbound', status: 'received' },
        { $set: { status: 'read', updatedAt: new Date() } }
      ),
    ]);

    // Add isMine helper so frontend knows which side to render each message
    const thread = messages.map(m => ({
      ...m,
      isMine: m.direction === 'outbound' || m.from === myPhone,
    }));

    console.log(`[GET /contact/:phone] found ${total} messages for ${phone}`);

    res.json({
      total,
      page,
      limit,
      contact,
      customerPhone: phone,
      businessPhone: myPhone,
      thread,
    });
  } catch (err) {
    console.error('[GET /contact/:phone]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// /:id route moved to bottom — see end of READ section

// GET /api/contacts/list
// Returns all contacts with last message preview — like WhatsApp conversation list.
router.get('/contacts/list', async (req, res) => {
  try {
    const contacts = await Contact.find().sort({ lastSeen: -1 }).lean();

    // For each contact, get the last message in the conversation
    const withPreview = await Promise.all(contacts.map(async (contact) => {
      const lastMsg = await Message.findOne({
        $or: [{ from: contact.phone }, { to: contact.phone }],
      })
        .sort({ waTimestamp: -1 })
        .select('type body direction status waTimestamp media')
        .lean();

      // Count unread inbound messages (received but not read)
      const unreadCount = await Message.countDocuments({
        from:      contact.phone,
        direction: 'inbound',
        status:    'received',
      });

      return {
        ...contact,
        lastMessage: lastMsg ? {
          type:        lastMsg.type,
          body:        lastMsg.body || (lastMsg.media ? `[${lastMsg.type}]` : ''),
          direction:   lastMsg.direction,
          status:      lastMsg.status,
          waTimestamp: lastMsg.waTimestamp,
        } : null,
        unreadCount,
      };
    }));

    res.json({ count: withPreview.length, contacts: withPreview });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/messages/:id

// GET /api/test-db — comprehensive DB + env diagnostic
router.get('/test-db', async (req, res) => {
  const results = {
    env: {
      WA_PHONE_NUMBER_ID: process.env.WA_PHONE_NUMBER_ID || 'NOT SET',
      WA_BUSINESS_PHONE:  process.env.WA_BUSINESS_PHONE  || 'NOT SET ← ADD THIS TO RAILWAY',
      WA_API_VERSION:     process.env.WA_API_VERSION      || 'NOT SET',
      MONGODB_URI:        process.env.MONGODB_URI          ? 'SET' : 'NOT SET',
      MEDIA_STORAGE:      process.env.MEDIA_STORAGE        || 'NOT SET',
      MINIO_BUCKET:       process.env.MINIO_BUCKET         || 'NOT SET',
      MINIO_INTERNAL_URL: process.env.MINIO_INTERNAL_URL   || 'NOT SET',
      MINIO_PUBLIC_URL:   process.env.MINIO_PUBLIC_URL     || 'NOT SET',
    },
    mongooseState:    null,
    mongooseWrite:    null,   // test via Mongoose model
    rawCollWrite:     null,   // test via Message.collection (raw driver)
    typeFieldCheck:   null,   // verify 'type' field saves correctly
    error:            null,
  };

  try {
    const mongoose = (await import('mongoose')).default;
    const dbName   = mongoose.connection.db?.databaseName || 'unknown';
    const collName = Message.collection?.name || 'unknown';
    results.mongooseState = `readyState=${mongoose.connection.readyState} db=${dbName} collection=${collName}`;

    const testId = `test_${Date.now()}`;
    const from   = process.env.WA_BUSINESS_PHONE || 'test_business';

    // Test 1: Mongoose model write
    try {
      const w = await Message.findOneAndUpdate(
        { messageId: testId + '_mongoose' },
        { $set: { messageId: testId + '_mongoose', direction: 'outbound', from, to: 'test_customer', type: 'text', body: 'mongoose test', waTimestamp: new Date(), status: 'sent' } },
        { upsert: true, new: true }
      );
      results.mongooseWrite = `OK _id=${w._id} type=${w.type}`;
      await Message.deleteOne({ messageId: testId + '_mongoose' });
    } catch (e) {
      results.mongooseWrite = `FAILED: ${e.message}`;
    }

    // Test 2: Raw collection write via mongoose.connection.db (what whatsappService uses)
    try {
      const col = mongoose.connection.db.collection('messages');
      const r = await col.updateOne(
        { messageId: testId + '_raw' },
        { $set: { messageId: testId + '_raw', direction: 'outbound', from, to: 'test_customer', type: 'text', body: 'raw test', waTimestamp: new Date(), status: 'sent', createdAt: new Date(), updatedAt: new Date() } },
        { upsert: true }
      );
      results.rawCollWrite = `OK matched=${r.matchedCount} upserted=${r.upsertedCount}`;

      // Read it back to verify type field
      const readBack = await col.findOne({ messageId: testId + '_raw' });
      results.typeFieldCheck = readBack ? `type=${readBack.type} direction=${readBack.direction} from=${readBack.from}` : 'NOT FOUND';
      await col.deleteOne({ messageId: testId + '_raw' });
    } catch (e) {
      results.rawCollWrite = `FAILED: ${e.message}`;
    }

  } catch (err) {
    results.error = err.message;
  }
  res.json(results);
});


// POST /api/write-test — writes directly to DB and returns result
// Use this to confirm DB write works from your app
router.post('/write-test', async (req, res) => {
  try {
    const { default: Message } = await import('../models/Message.js');
    const testId = `writetest_${Date.now()}`;
    const doc = {
      messageId:   testId,
      direction:   'outbound',
      type:        'text',
      from:        process.env.WA_BUSINESS_PHONE || 'test',
      to:          req.body.to || 'test_customer',
      body:        req.body.text || 'write test',
      status:      'sent',
      waTimestamp: new Date(),
    };
    const result = await Message.collection.updateOne(
      { messageId: testId },
      { $set: { ...doc, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    const readBack = await Message.collection.findOne({ messageId: testId });
    res.json({
      success:     true,
      matched:     result.matchedCount,
      upserted:    result.upsertedCount,
      savedDoc:    readBack,
      dbName:      Message.collection.conn.db.databaseName,
      collName:    Message.collection.name,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const message = await Message.findOne({ messageId: req.params.id }).lean();
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json(message);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/send  — Universal send endpoint, routes by "type" field
//
// Accepts the exact WhatsApp Cloud API JSON format:
//
//   Text:
//     { "messaging_product":"whatsapp", "to":"919...", "type":"text",
//       "text": { "body": "Hello" } }
//
//   Image by URL:
//     { "messaging_product":"whatsapp", "to":"919...", "type":"image",
//       "image": { "link": "https://...", "caption": "..." } }
//
//   Image by media ID:
//     { "messaging_product":"whatsapp", "to":"919...", "type":"image",
//       "image": { "id": "media_id", "caption": "..." } }
//
//   Video:
//     { "messaging_product":"whatsapp", "to":"919...", "type":"video",
//       "video": { "link": "https://...", "caption": "..." } }
//
//   Audio:
//     { "messaging_product":"whatsapp", "to":"919...", "type":"audio",
//       "audio": { "link": "https://..." } }
//
//   Document:
//     { "messaging_product":"whatsapp", "to":"919...", "type":"document",
//       "document": { "link": "https://...", "filename": "file.pdf", "caption": "..." } }
//
//   Location:
//     { "messaging_product":"whatsapp", "to":"919...", "type":"location",
//       "location": { "latitude": 17.38, "longitude": 78.48, "name": "...", "address": "..." } }
//
//   Template:
//     { "messaging_product":"whatsapp", "to":"919...", "type":"template",
//       "template": { "name": "hello_world", "language": { "code": "en_US" } } }
//
// ─────────────────────────────────────────────────────────────────────────────
router.post('/send', upload.single('media'), async (req, res) => {
  try {
    console.log(`\n📨 POST /api/send body:`, JSON.stringify(req.body));
    const { to, type } = req.body;

    if (!to)   return res.status(400).json({ error: '"to" is required' });
    if (!type) return res.status(400).json({ error: '"type" is required (text/image/video/audio/document/location/template)' });

    let result;

    switch (type) {

      case 'text': {
        const raw  = req.body.text;
        const body = typeof raw === 'object' ? raw?.body : raw;
        if (!body) return res.status(400).json({ error: '"text.body" is required for type=text' });
        result = await sendText(to, body);
        break;
      }

      case 'image': {
        const img     = req.body.image || {};
        const caption = img.caption || req.body.caption || '';
        const url     = img.link    || req.body.url     || '';
        const mediaId = img.id      || req.body.mediaId || '';
        const opts    = { caption, url: url || undefined, mediaId: mediaId || undefined };
        if (req.file) { opts.filePath = req.file.path; opts.mimeType = req.file.mimetype; }
        if (!url && !mediaId && !req.file) return res.status(400).json({ error: 'image.link, image.id, or file upload required' });
        result = await sendImage(to, opts);
        break;
      }

      case 'video': {
        const vid     = req.body.video || {};
        const caption = vid.caption || req.body.caption || '';
        const url     = vid.link    || req.body.url     || '';
        const mediaId = vid.id      || req.body.mediaId || '';
        const opts    = { caption, url: url || undefined, mediaId: mediaId || undefined };
        if (req.file) { opts.filePath = req.file.path; opts.mimeType = req.file.mimetype; }
        if (!url && !mediaId && !req.file) return res.status(400).json({ error: 'video.link, video.id, or file upload required' });
        result = await sendVideo(to, opts);
        break;
      }

      case 'audio': {
        const aud     = req.body.audio || {};
        const url     = aud.link  || req.body.url     || '';
        const mediaId = aud.id    || req.body.mediaId || '';
        const opts    = { url: url || undefined, mediaId: mediaId || undefined };
        if (req.file) { opts.filePath = req.file.path; opts.mimeType = req.file.mimetype; }
        if (!url && !mediaId && !req.file) return res.status(400).json({ error: 'audio.link, audio.id, or file upload required' });
        result = await sendAudio(to, opts);
        break;
      }

      case 'document': {
        const doc      = req.body.document || {};
        const caption  = doc.caption  || req.body.caption  || '';
        const fileName = doc.filename || req.body.fileName || '';
        const url      = doc.link     || req.body.url      || '';
        const mediaId  = doc.id       || req.body.mediaId  || '';
        const opts     = { caption, fileName, url: url || undefined, mediaId: mediaId || undefined };
        if (req.file) { opts.filePath = req.file.path; opts.mimeType = req.file.mimetype; opts.fileName = opts.fileName || req.file.originalname; }
        if (!url && !mediaId && !req.file) return res.status(400).json({ error: 'document.link, document.id, or file upload required' });
        result = await sendDocument(to, opts);
        break;
      }

      case 'location': {
        const loc = req.body.location || {};
        if (!loc.latitude || !loc.longitude) return res.status(400).json({ error: 'location.latitude and location.longitude are required' });
        result = await sendLocation(to, { latitude: loc.latitude, longitude: loc.longitude, name: loc.name || '', address: loc.address || '' });
        break;
      }

      case 'template': {
        const tmpl = req.body.template || {};
        if (!tmpl.name) return res.status(400).json({ error: 'template.name is required' });
        result = await sendTemplate(to, tmpl.name, tmpl.language?.code || 'en_US', tmpl.components || []);
        break;
      }

      default:
        return res.status(400).json({ error: `Unsupported type: "${type}". Use: text, image, video, audio, document, location, template` });
    }
    
    console.log("   ✅ send complete, result:", result);
    res.json(result);
  } catch (err) {
    console.error(`[POST /api/send] ERROR:`, err.message);
    res.status(500).json({ error: err.message });
  }
});


// GET /api/conversations
// Same as contacts/list but supports search by phone or name.
// This is the main entry point for the conversation list view.
router.get('/conversations', async (req, res) => {
  try {
    const search = (req.query.q || '').trim();
    const filter = search
      ? { $or: [
          { phone: { $regex: search, $options: 'i' } },
          { name:  { $regex: search, $options: 'i' } },
          { waId:  { $regex: search, $options: 'i' } },
        ]}
      : {};

    const contacts = await Contact.find(filter).sort({ lastSeen: -1 }).lean();

    const withPreview = await Promise.all(contacts.map(async (contact) => {
      const lastMsg = await Message.findOne({
        $or: [{ from: contact.phone }, { to: contact.phone }],
      })
        .sort({ waTimestamp: -1 })
        .select('type body direction status waTimestamp media')
        .lean();

      const unreadCount = await Message.countDocuments({
        from:      contact.phone,
        direction: 'inbound',
        status:    'received',
      });

      return {
        phone:       contact.phone,
        name:        contact.name || contact.phone,
        lastSeen:    contact.lastSeen,
        messageCount: contact.messageCount,
        unreadCount,
        lastMessage: lastMsg ? {
          type:        lastMsg.type,
          body:        lastMsg.body || (lastMsg.media ? `[${lastMsg.type}]` : ''),
          direction:   lastMsg.direction,
          status:      lastMsg.status,
          waTimestamp: lastMsg.waTimestamp,
        } : null,
      };
    }));

    res.json({ count: withPreview.length, conversations: withPreview });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SEND ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/send/text
router.post('/send/text', async (req, res) => {
  // THIS LOG PROVES THE REQUEST REACHED YOUR APP
  console.log('\n🔴🔴🔴 /api/send/text HIT 🔴🔴🔴');
  console.log('body:', JSON.stringify(req.body));
  console.log(`\n${'='.repeat(50)}`);
  console.log(`[POST /send/text] body:`, JSON.stringify(req.body));
  console.log(`[POST /send/text] mongoose readyState=${mongoose.connection.readyState}`);
  console.log(`[POST /send/text] db=${mongoose.connection.db?.databaseName}`);
  try {
    const { to } = req.body;

    // Accept both formats:
    //   { "to": "919...", "text": "Hello" }
    //   { "to": "919...", "text": { "body": "Hello" } }  ← WhatsApp API format
    const rawText = req.body.text;
    const text    = typeof rawText === 'object' && rawText?.body
                    ? rawText.body          // extract from { body: "..." }
                    : rawText;              // use as plain string

    if (!to)   return res.status(400).json({ error: 'to is required' });
    if (!text) return res.status(400).json({ error: 'text is required' });

    // Direct DB write test BEFORE calling sendText
    try {
      const col    = mongoose.connection.db.collection('messages');
      const testId = `route_test_${Date.now()}`;
      await col.insertOne({ messageId: testId, direction: 'outbound', type: 'text', body: text, to, from: process.env.WA_BUSINESS_PHONE, status: 'test', createdAt: new Date() });
      console.log(`[POST /send/text] ✅ Direct DB write OK testId=${testId}`);
      await col.deleteOne({ messageId: testId });
    } catch (dbTestErr) {
      console.error(`[POST /send/text] ❌ Direct DB write FAILED: ${dbTestErr.message}`);
    }

    const result = await sendText(to, text);
    console.log(`[POST /send/text] ✅ sendText complete`);
    res.json(result);
  } catch (err) {
    console.error(`[POST /send/text] ❌ ERROR: ${err.message}`);
    console.error(err.stack);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/image
// JSON:      { "to": "919...", "url": "https://...", "caption": "..." }
// Multipart: form-data fields: to, caption + file field named "media"
router.post('/send/image', upload.single('media'), async (req, res) => {
  try {
    console.log(`\n[POST /send/image] body:`, req.body);
    console.log(`[POST /send/image] file:`, req.file ? `${req.file.path} (${req.file.size} bytes)` : 'none');

    const to      = (req.body.to      || '').trim();
    const caption = (req.body.caption || '').trim();
    const url     = (req.body.url     || '').trim();

    if (!to) return res.status(400).json({ error: 'to is required' });

    const opts = { caption };
    if (req.file) {
      opts.filePath = req.file.path;
      opts.mimeType = req.file.mimetype;
    } else if (url) {
      opts.url = url;
    } else {
      return res.status(400).json({ error: 'Provide url or upload a file in the "media" field' });
    }

    const result = await sendImage(to, opts);
    res.json(result);
  } catch (err) {
    console.error(`[POST /send/image] ERROR:`, err.message);
    console.error(`[ROUTE ERROR] ${err.message}`, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/video
// JSON:      { "to": "919...", "url": "https://...", "caption": "..." }
// Multipart: form-data fields: to, caption + file field named "media"
router.post('/send/video', upload.single('media'), async (req, res) => {
  try {
    console.log(`\n[POST /send/video] body:`, req.body);
    console.log(`[POST /send/video] file:`, req.file ? `${req.file.path}` : 'none');

    const to      = (req.body.to      || '').trim();
    const caption = (req.body.caption || '').trim();
    const url     = (req.body.url     || '').trim();

    if (!to) return res.status(400).json({ error: 'to is required' });

    const opts = { caption };
    if (req.file) {
      opts.filePath = req.file.path;
      opts.mimeType = req.file.mimetype;
    } else if (url) {
      opts.url = url;
    } else {
      return res.status(400).json({ error: 'Provide url or upload a file in the "media" field' });
    }

    const result = await sendVideo(to, opts);
    res.json(result);
  } catch (err) {
    console.error(`[POST /send/video] ERROR:`, err.message);
    console.error(`[ROUTE ERROR] ${err.message}`, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/audio
// JSON:      { "to": "919...", "url": "https://..." }
// Multipart: form-data fields: to + file field named "media"
router.post('/send/audio', upload.single('media'), async (req, res) => {
  try {
    console.log(`\n[POST /send/audio] body:`, req.body);
    console.log(`[POST /send/audio] file:`, req.file ? `${req.file.path}` : 'none');

    const to  = (req.body.to  || '').trim();
    const url = (req.body.url || '').trim();

    if (!to) return res.status(400).json({ error: 'to is required' });

    const opts = {};
    if (req.file) {
      opts.filePath = req.file.path;
      opts.mimeType = req.file.mimetype;
    } else if (url) {
      opts.url = url;
    } else {
      return res.status(400).json({ error: 'Provide url or upload a file in the "media" field' });
    }

    const result = await sendAudio(to, opts);
    res.json(result);
  } catch (err) {
    console.error(`[POST /send/audio] ERROR:`, err.message);
    console.error(`[ROUTE ERROR] ${err.message}`, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/document
// JSON:      { "to": "919...", "url": "https://...", "caption": "...", "fileName": "..." }
// Multipart: form-data fields: to, caption, fileName + file field named "media"
router.post('/send/document', upload.single('media'), async (req, res) => {
  try {
    console.log(`\n[POST /send/document] body:`, req.body);
    console.log(`[POST /send/document] file:`, req.file ? `${req.file.path}` : 'none');

    const to       = (req.body.to       || '').trim();
    const caption  = (req.body.caption  || '').trim();
    const url      = (req.body.url      || '').trim();
    const fileName = (req.body.fileName || '').trim();

    if (!to) return res.status(400).json({ error: 'to is required' });

    const opts = { caption, fileName };
    if (req.file) {
      opts.filePath = req.file.path;
      opts.mimeType = req.file.mimetype;
      opts.fileName = opts.fileName || req.file.originalname;
    } else if (url) {
      opts.url = url;
    } else {
      return res.status(400).json({ error: 'Provide url or upload a file in the "media" field' });
    }

    const result = await sendDocument(to, opts);
    res.json(result);
  } catch (err) {
    console.error(`[POST /send/document] ERROR:`, err.message);
    console.error(`[ROUTE ERROR] ${err.message}`, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/location
// JSON: { "to": "919...", "latitude": 17.38, "longitude": 78.48, "name": "...", "address": "..." }
router.post('/send/location', async (req, res) => {
  try {
    const { to, latitude, longitude, name, address } = req.body;
    if (!to || latitude == null || longitude == null) {
      return res.status(400).json({ error: 'to, latitude and longitude are required' });
    }
    const result = await sendLocation(to, { latitude, longitude, name, address });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/send/template
router.post('/send/template', async (req, res) => {
  try {
    const { to, templateName, languageCode, components } = req.body;
    if (!to || !templateName) return res.status(400).json({ error: 'to and templateName required' });
    const result = await sendTemplate(to, templateName, languageCode, components);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/send/buttons
router.post('/send/buttons', async (req, res) => {
  try {
    const { to, bodyText, buttons, headerText, footerText } = req.body;
    if (!to || !bodyText || !buttons?.length) return res.status(400).json({ error: 'to, bodyText and buttons required' });
    const result = await sendButtons(to, bodyText, buttons, headerText, footerText);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/send/list
router.post('/send/list', async (req, res) => {
  try {
    const { to, bodyText, buttonLabel, sections } = req.body;
    if (!to || !bodyText || !buttonLabel || !sections?.length) return res.status(400).json({ error: 'to, bodyText, buttonLabel and sections required' });
    const result = await sendList(to, bodyText, buttonLabel, sections);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/upload — upload to WA CDN → get reusable mediaId
router.post('/upload', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "media")' });
    const mime    = req.body.mimeType || req.file.mimetype;
    const mediaId = await uploadMedia(req.file.path, mime);
    res.json({ mediaId, fileName: req.file.originalname, mimeType: mime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─────────────────────────────────────────────────────────────────────────────
// TOKEN ADMIN ROUTES
// All require ADMIN_SECRET in query (?secret=xxx) or request body
// ─────────────────────────────────────────────────────────────────────────────

// GET  /api/admin/token-status   — view token info + permissions
router.get('/admin/token-status',  handleTokenStatus);

// POST /api/admin/refresh-token  — auto-exchange current token for new 60-day token
router.post('/admin/refresh-token', handleRefreshToken);

// POST /api/admin/update-token   — paste a new token manually
// Body: { secret: "...", token: "EAAxxxxx" }
router.post('/admin/update-token',  handleUpdateToken);


// ─────────────────────────────────────────────────────────────────────────────
// CONFIG ADMIN ROUTES — manage WhatsApp env vars stored in MongoDB
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/config — view all config values stored in MongoDB
router.get('/admin/config', async (req, res) => {
  const secret = req.query.secret || req.body?.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const config = await getAllConfig();
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/config — update one or more config values in MongoDB
// Body: { secret: "...", WA_ACCESS_TOKEN: "EAAxx", WA_API_VERSION: "v19.0", ... }
router.post('/admin/config', async (req, res) => {
  const { secret, ...updates } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const allowed = Object.keys(updates).filter(k => MANAGED_KEYS.includes(k));
  if (allowed.length === 0) {
    return res.status(400).json({
      error: 'No valid keys provided',
      validKeys: MANAGED_KEYS,
    });
  }

  const saved = [];
  for (const key of allowed) {
    await saveConfigToDB(key, updates[key]);
    saved.push(key);
  }

  res.json({ success: true, saved, message: `${saved.length} config value(s) updated in MongoDB` });
});


export default router;
