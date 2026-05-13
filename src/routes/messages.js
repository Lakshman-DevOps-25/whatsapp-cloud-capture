/**
 * messages.js — REST API
 *
 * READ
 *   GET  /api/messages                   paginated message list
 *   GET  /api/messages/media             messages with media files
 *   GET  /api/messages/outbound          outbound messages only
 *   GET  /api/messages/contact/:phone    full conversation with a contact
 *   GET  /api/messages/:id               single message by messageId
 *   GET  /api/contacts/list              all contacts
 *
 * SEND  (all save to MongoDB automatically)
 *   POST /api/send/text
 *   POST /api/send/image      JSON { to, url, caption } OR multipart file upload
 *   POST /api/send/video      JSON { to, url, caption } OR multipart file upload
 *   POST /api/send/audio      JSON { to, url }          OR multipart file upload
 *   POST /api/send/document   JSON { to, url, caption, fileName } OR multipart
 *   POST /api/send/location   JSON { to, latitude, longitude, name, address }
 *   POST /api/send/template   JSON { to, templateName, languageCode, components }
 *   POST /api/send/buttons    JSON { to, bodyText, buttons, headerText, footerText }
 *   POST /api/send/list       JSON { to, bodyText, buttonLabel, sections }
 *   POST /api/upload          multipart file → { mediaId, fileName, mimeType }
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

// ── Multer — temp disk storage for uploaded files ─────────────────────────────
const TEMP_DIR = './uploads/tmp';
mkdirSync(TEMP_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_DIR),
  filename:    (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 64 * 1024 * 1024 } }); // 64 MB

// ─────────────────────────────────────────────────────────────────────────────
// READ ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/messages
router.get('/', async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page  || '1'), 1);
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const filter = {};
    if (req.query.type)      filter.type      = req.query.type;
    if (req.query.direction) filter.direction = req.query.direction;
    if (req.query.status)    filter.status    = req.query.status;

    const [messages, total] = await Promise.all([
      Message.find(filter).sort({ waTimestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Message.countDocuments(filter),
    ]);
    res.json({ total, page, limit, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/outbound — all sent messages with full details
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/media
router.get('/media', async (req, res) => {
  try {
    const filter = { 'media.mediaId': { $exists: true } };
    if (req.query.type)      filter.type      = req.query.type;
    if (req.query.direction) filter.direction = req.query.direction;

    const messages = await Message.find(filter).sort({ waTimestamp: -1 }).limit(100).lean();
    res.json({ count: messages.length, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/contact/:phone
router.get('/contact/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const page  = Math.max(parseInt(req.query.page  || '1'), 1);
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);

    const [messages, contact, total] = await Promise.all([
      Message.find({ $or: [{ from: phone }, { to: phone }] })
        .sort({ waTimestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Contact.findOne({ phone }).lean(),
      Message.countDocuments({ $or: [{ from: phone }, { to: phone }] }),
    ]);
    res.json({ total, page, limit, contact, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/:id
router.get('/:id', async (req, res) => {
  try {
    const message = await Message.findOne({ messageId: req.params.id }).lean();
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contacts/list
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
// { to, text }
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
// JSON:      { to, url, caption }
// Multipart: to + caption + file(media)  ← also stores copy in MinIO
router.post('/send/image', upload.single('media'), async (req, res) => {
  try {
    const { to, caption, url } = req.body;
    if (!to) return res.status(400).json({ error: 'to is required' });

    const opts = { url, caption };
    if (req.file) {
      opts.filePath = req.file.path;
      opts.mimeType = req.file.mimetype;
    }

    const result = await sendImage(to, opts);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/video
router.post('/send/video', upload.single('media'), async (req, res) => {
  try {
    const { to, caption, url } = req.body;
    if (!to) return res.status(400).json({ error: 'to is required' });

    const opts = { url, caption };
    if (req.file) {
      opts.filePath = req.file.path;
      opts.mimeType = req.file.mimetype;
    }

    const result = await sendVideo(to, opts);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/audio
router.post('/send/audio', upload.single('media'), async (req, res) => {
  try {
    const { to, url } = req.body;
    if (!to) return res.status(400).json({ error: 'to is required' });

    const opts = { url };
    if (req.file) {
      opts.filePath = req.file.path;
      opts.mimeType = req.file.mimetype;
    }

    const result = await sendAudio(to, opts);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/document
router.post('/send/document', upload.single('media'), async (req, res) => {
  try {
    const { to, caption, url, fileName } = req.body;
    if (!to) return res.status(400).json({ error: 'to is required' });

    const opts = { url, caption, fileName };
    if (req.file) {
      opts.filePath = req.file.path;
      opts.mimeType = req.file.mimetype;
      opts.fileName = opts.fileName || req.file.originalname;
    }

    const result = await sendDocument(to, opts);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/location
// { to, latitude, longitude, name, address }
router.post('/send/location', async (req, res) => {
  try {
    const { to, latitude, longitude, name, address } = req.body;
    if (!to || latitude == null || longitude == null) {
      return res.status(400).json({ error: 'to, latitude and longitude are required' });
    }
    const result = await sendLocation(to, { latitude, longitude, name, address });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send/template
// { to, templateName, languageCode, components }
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
// { to, bodyText, buttons: [{id, title}], headerText?, footerText? }
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

// POST /api/send/list
// { to, bodyText, buttonLabel, sections: [{title, rows:[{id,title,description}]}] }
router.post('/send/list', async (req, res) => {
  try {
    const { to, bodyText, buttonLabel, sections } = req.body;
    if (!to || !bodyText || !buttonLabel || !sections?.length) {
      return res.status(400).json({ error: 'to, bodyText, buttonLabel and sections are required' });
    }
    const result = await sendList(to, bodyText, buttonLabel, sections);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload — upload to WhatsApp CDN → get reusable media ID
// Multipart: file field 'media'
router.post('/upload', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const mime    = req.body.mimeType || req.file.mimetype;
    const mediaId = await uploadMedia(req.file.path, mime);
    res.json({ mediaId, fileName: req.file.originalname, mimeType: mime });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
