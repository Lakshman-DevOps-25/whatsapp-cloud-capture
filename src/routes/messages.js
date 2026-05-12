/**
 * messages.js — REST API for querying captured messages
 *
 * GET  /api/messages                   — list all messages (paginated)
 * GET  /api/messages/:id               — single message by messageId
 * GET  /api/messages/contact/:phone    — conversation with a contact
 * GET  /api/messages/media             — all messages that have media
 * POST /api/send/text                  — send a text message
 * POST /api/send/image                 — send an image (URL or upload)
 * POST /api/send/video                 — send a video
 * POST /api/send/audio                 — send audio
 * POST /api/send/document              — send a document
 * POST /api/send/location              — send a location pin
 * POST /api/send/template              — send a template message
 * POST /api/send/buttons               — send interactive buttons
 * POST /api/upload                     — upload local file to WA CDN → media ID
 */

import express from 'express';
import multer from 'multer';
import path from 'path';
import { mkdirSync } from 'fs';
import Message from '../models/Message.js';
import Contact from '../models/Contact.js';
import {
  sendText,
  sendImage,
  sendVideo,
  sendAudio,
  sendDocument,
  sendSticker,
  sendLocation,
  sendTemplate,
  sendButtons,
  sendList,
  uploadMedia,
} from '../services/whatsappService.js';

const router = express.Router();

// ── Multer — temporary local storage for uploads ──────────────────────────────
const TEMP_DIR = './uploads/tmp';
mkdirSync(TEMP_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_DIR),
  filename: (_req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 64 * 1024 * 1024 } }); // 64 MB

// ─────────────────────────────────────────────────────────────────────────────
// READ ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/messages — paginated list
router.get('/', async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page  || '1'), 1);
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const type  = req.query.type;
    const dir   = req.query.direction;

    const filter = {};
    if (type) filter.type = type;
    if (dir)  filter.direction = dir;

    const [messages, total] = await Promise.all([
      Message.find(filter)
        .sort({ waTimestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Message.countDocuments(filter),
    ]);

    res.json({ total, page, limit, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/media — all messages with media
router.get('/media', async (req, res) => {
  try {
    const type = req.query.type; // image|video|audio|document|sticker
    const filter = { 'media.mediaId': { $exists: true } };
    if (type) filter.type = type;

    const messages = await Message.find(filter)
      .sort({ waTimestamp: -1 })
      .limit(100)
      .lean();

    res.json({ count: messages.length, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/contact/:phone — conversation thread
router.get('/contact/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const page  = Math.max(parseInt(req.query.page || '1'), 1);
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);

    const [messages, contact, total] = await Promise.all([
      Message.find({ $or: [{ from: phone }, { to: phone }] })
        .sort({ waTimestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Contact.findOne({ phone }).lean(),
      Message.countDocuments({ $or: [{ from: phone }, { to: phone }] }),
    ]);

    res.json({ total, page, limit, contact, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/:id — single message
router.get('/:id', async (req, res) => {
  try {
    const message = await Message.findOne({ messageId: req.params.id }).lean();
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts — list contacts
router.get('/contacts/list', async (req, res) => {
  try {
    const contacts = await Contact.find().sort({ lastSeen: -1 }).lean();
    res.json({ count: contacts.length, contacts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SEND ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/send/text
// Body: { to, text }
router.post('/send/text', async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'to and text are required' });
    const result = await sendText(to, text);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/image
// Body (JSON):  { to, url, caption }
// Body (form):  { to, caption } + file field 'media'
router.post('/send/image', upload.single('media'), async (req, res) => {
  try {
    const { to, caption, url } = req.body;
    if (!to) return res.status(400).json({ error: 'to is required' });

    let mediaId;
    if (req.file) {
      mediaId = await uploadMedia(req.file.path, req.file.mimetype);
    }

    const result = await sendImage(to, { url, mediaId, caption });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/video
// Body (JSON):  { to, url, caption }
// Body (form):  { to, caption } + file field 'media'
router.post('/send/video', upload.single('media'), async (req, res) => {
  try {
    const { to, caption, url } = req.body;
    if (!to) return res.status(400).json({ error: 'to is required' });

    let mediaId;
    if (req.file) {
      mediaId = await uploadMedia(req.file.path, req.file.mimetype);
    }

    const result = await sendVideo(to, { url, mediaId, caption });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/audio
// Body (JSON):  { to, url }
// Body (form):  { to } + file field 'media'
router.post('/send/audio', upload.single('media'), async (req, res) => {
  try {
    const { to, url } = req.body;
    if (!to) return res.status(400).json({ error: 'to is required' });

    let mediaId;
    if (req.file) {
      mediaId = await uploadMedia(req.file.path, req.file.mimetype);
    }

    const result = await sendAudio(to, { url, mediaId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/document
// Body (JSON):  { to, url, caption, fileName }
// Body (form):  { to, caption } + file field 'media'
router.post('/send/document', upload.single('media'), async (req, res) => {
  try {
    const { to, caption, url, fileName } = req.body;
    if (!to) return res.status(400).json({ error: 'to is required' });

    let mediaId;
    let resolvedFileName = fileName;
    if (req.file) {
      mediaId = await uploadMedia(req.file.path, req.file.mimetype);
      resolvedFileName = resolvedFileName || req.file.originalname;
    }

    const result = await sendDocument(to, { url, mediaId, caption, fileName: resolvedFileName });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/location
// Body: { to, latitude, longitude, name, address }
router.post('/send/location', async (req, res) => {
  try {
    const { to, latitude, longitude, name, address } = req.body;
    if (!to || !latitude || !longitude) {
      return res.status(400).json({ error: 'to, latitude, longitude are required' });
    }
    const result = await sendLocation(to, { latitude, longitude, name, address });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/template
// Body: { to, templateName, languageCode, components }
router.post('/send/template', async (req, res) => {
  try {
    const { to, templateName, languageCode, components } = req.body;
    if (!to || !templateName) {
      return res.status(400).json({ error: 'to and templateName are required' });
    }
    const result = await sendTemplate(to, templateName, languageCode, components);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/buttons
// Body: { to, bodyText, buttons: [{id, title}], headerText, footerText }
router.post('/send/buttons', async (req, res) => {
  try {
    const { to, bodyText, buttons, headerText, footerText } = req.body;
    if (!to || !bodyText || !buttons?.length) {
      return res.status(400).json({ error: 'to, bodyText and buttons are required' });
    }
    const result = await sendButtons(to, bodyText, buttons, headerText, footerText);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload — upload file to WhatsApp CDN, get back a reusable media ID
// Form: file field 'media', body field 'mimeType' (optional override)
router.post('/upload', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const mime = req.body.mimeType || req.file.mimetype;
    const mediaId = await uploadMedia(req.file.path, mime);
    res.json({ mediaId, fileName: req.file.originalname, mimeType: mime });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
