/**
 * messages.js — REST API
 */

import express   from 'express';
import multer    from 'multer';
import path      from 'path';
import os        from 'os';
import { mkdirSync } from 'fs';
import Message   from '../models/Message.js';
import Contact   from '../models/Contact.js';
import {
  sendText, sendImage, sendVideo, sendAudio,
  sendDocument, sendSticker, sendLocation,
  sendTemplate, sendButtons, sendList, uploadMedia,
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
    if (req.query.type)      filter.type      = req.query.type;
    if (req.query.direction) filter.direction = req.query.direction;
    if (req.query.status)    filter.status    = req.query.status;
    const [messages, total] = await Promise.all([
      Message.find(filter).sort({ waTimestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Message.countDocuments(filter),
    ]);
    res.json({ total, page, limit, messages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/messages/outbound
router.get('/outbound', async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page  || '1'), 1);
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const filter = { direction: 'outbound' };
    if (req.query.type)   filter.type   = req.query.type;
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
    if (req.query.type)      filter.type      = req.query.type;
    if (req.query.direction) filter.direction = req.query.direction;
    const messages = await Message.find(filter).sort({ waTimestamp: -1 }).limit(100).lean();
    res.json({ count: messages.length, messages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/messages/contact/:phone
router.get('/contact/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const page  = Math.max(parseInt(req.query.page  || '1'), 1);
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const [messages, contact, total] = await Promise.all([
      Message.find({ $or: [{ from: phone }, { to: phone }] }).sort({ waTimestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Contact.findOne({ phone }).lean(),
      Message.countDocuments({ $or: [{ from: phone }, { to: phone }] }),
    ]);
    res.json({ total, page, limit, contact, messages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/messages/:id
router.get('/:id', async (req, res) => {
  try {
    const message = await Message.findOne({ messageId: req.params.id }).lean();
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json(message);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/contacts/list
router.get('/contacts/list', async (req, res) => {
  try {
    const contacts = await Contact.find().sort({ lastSeen: -1 }).lean();
    res.json({ count: contacts.length, contacts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SEND ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// ─── POST /api/send (universal — routes by type field) ────────────────────────
router.post('/send', upload.single('media'), async (req, res) => {
  console.log('\n' + '█'.repeat(50));
  console.log('🔴 POST /api/send HIT');
  console.log('body:', JSON.stringify(req.body));
  console.log('█'.repeat(50));
 
  try {
    const { to, type } = req.body;
 
    if (!to)   return res.status(400).json({ error: '"to" is required' });
    if (!type) return res.status(400).json({ error: '"type" is required' });
 
    let result;
 
    switch (type) {
 
      case 'text': {
        const rawText  = req.body.text;
        const bodyText = (typeof rawText === 'object' && rawText !== null)
          ? (rawText.body || '')
          : (rawText || '');
        if (!bodyText) return res.status(400).json({ error: 'text.body is required for type=text' });
        console.log(`   text body: "${bodyText}"`);
        result = await sendText(to, bodyText);
        break;
      }
 
      case 'image': {
        const img     = req.body.image || {};
        const caption = img.caption || req.body.caption || '';
        const url     = img.link    || req.body.url     || '';
        const mediaId = img.id      || req.body.mediaId || '';
        const opts    = { caption, url: url||undefined, mediaId: mediaId||undefined };
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
        const opts    = { caption, url: url||undefined, mediaId: mediaId||undefined };
        if (req.file) { opts.filePath = req.file.path; opts.mimeType = req.file.mimetype; }
        if (!url && !mediaId && !req.file) return res.status(400).json({ error: 'video.link, video.id, or file upload required' });
        result = await sendVideo(to, opts);
        break;
      }
 
      case 'audio': {
        const aud     = req.body.audio || {};
        const url     = aud.link  || req.body.url     || '';
        const mediaId = aud.id    || req.body.mediaId || '';
        const opts    = { url: url||undefined, mediaId: mediaId||undefined };
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
        const opts     = { caption, fileName, url: url||undefined, mediaId: mediaId||undefined };
        if (req.file) { opts.filePath = req.file.path; opts.mimeType = req.file.mimetype; opts.fileName = opts.fileName || req.file.originalname; }
        if (!url && !mediaId && !req.file) return res.status(400).json({ error: 'document.link, document.id, or file upload required' });
        result = await sendDocument(to, opts);
        break;
      }
 
      case 'location': {
        const loc = req.body.location || {};
        if (!loc.latitude || !loc.longitude) return res.status(400).json({ error: 'location.latitude and longitude required' });
        result = await sendLocation(to, { latitude: loc.latitude, longitude: loc.longitude, name: loc.name||'', address: loc.address||'' });
        break;
      }
 
      case 'template': {
        const tmpl = req.body.template || {};
        if (!tmpl.name) return res.status(400).json({ error: 'template.name is required' });
        result = await sendTemplate(to, tmpl.name, tmpl.language?.code || 'en_US', tmpl.components || []);
        break;
      }
 
      default:
        return res.status(400).json({ error: `Unsupported type: "${type}"` });
    }
 
    res.json(result);
  } catch (err) {
    console.error('❌ /api/send ERROR:', err.message);
    console.error(err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/send/text ──────────────────────────────────────────────────────
// Accepts both formats:
//   Format 1: { "to": "918...", "text": "Hello" }
//   Format 2: { "messaging_product":"whatsapp", "to":"918...", "type":"text", "text":{"body":"Hello"} }
router.post('/send/text', async (req, res) => {
  console.log('\n' + '█'.repeat(50));
  console.log('🔴 POST /api/send/text HIT');
  console.log('body:', JSON.stringify(req.body));
  console.log('WA_PHONE_NUMBER_ID:', process.env.WA_PHONE_NUMBER_ID || 'NOT SET');
  console.log('WA_BUSINESS_PHONE :', process.env.WA_BUSINESS_PHONE  || 'NOT SET');
  console.log('WA_ACCESS_TOKEN   :', process.env.WA_ACCESS_TOKEN ? 'SET' : 'NOT SET');
  console.log('█'.repeat(50));
 
  try {
    const { to } = req.body;
 
    // Handle both string and object formats for text
    const rawText  = req.body.text;
    const bodyText = (typeof rawText === 'object' && rawText !== null)
      ? (rawText.body || '')
      : (rawText || '');
 
    if (!to)       return res.status(400).json({ error: 'to is required' });
    if (!bodyText) return res.status(400).json({ error: 'text or text.body is required' });
 
    console.log(`   Extracted: to=${to} bodyText="${bodyText}"`);
 
    const result = await sendText(to, bodyText);
    res.json(result);
  } catch (err) {
    console.error('❌ /api/send/text ERROR:', err.message);
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

// GET /api/test-db — verify env vars and DB write
router.get('/test-db', async (req, res) => {
  const results = {
    env: {
      WA_PHONE_NUMBER_ID: process.env.WA_PHONE_NUMBER_ID || 'NOT SET',
      WA_BUSINESS_PHONE:  process.env.WA_BUSINESS_PHONE  || 'NOT SET',
      WA_API_VERSION:     process.env.WA_API_VERSION      || 'NOT SET',
      MONGODB_URI:        process.env.MONGODB_URI          ? 'SET' : 'NOT SET',
      MEDIA_STORAGE:      process.env.MEDIA_STORAGE        || 'NOT SET',
      MINIO_BUCKET:       process.env.MINIO_BUCKET         || 'NOT SET',
      MINIO_INTERNAL_URL: process.env.MINIO_INTERNAL_URL   || 'NOT SET',
      MINIO_PUBLIC_URL:   process.env.MINIO_PUBLIC_URL     || 'NOT SET',
      TEMP_DIR,
    },
    dbWrite: null,
    dbRead:  null,
    error:   null,
  };
  try {
    const testId  = `test_${Date.now()}`;
    const written = await Message.findOneAndUpdate(
      { messageId: testId },
      { $set: { messageId: testId, direction: 'outbound', from: process.env.WA_BUSINESS_PHONE || 'test', to: 'test_customer', type: 'text', body: 'DB write test', waTimestamp: new Date(), status: 'sent' } },
      { upsert: true, new: true }
    );
    results.dbWrite = `SUCCESS _id=${written._id}`;
    const read = await Message.findOne({ messageId: testId });
    results.dbRead  = read ? `SUCCESS direction=${read.direction} from=${read.from} to=${read.to}` : 'NOT FOUND';
    await Message.deleteOne({ messageId: testId });
  } catch (err) {
    results.error = err.message;
  }
  res.json(results);
});

export default router;
