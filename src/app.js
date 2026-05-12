import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import { connectDB } from './config/db.js';
import { ensureBucket } from './config/minioClient.js';
import webhookRouter  from './routes/webhook.js';
import messagesRouter from './routes/messages.js';

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Serve downloaded media files locally
app.use('/media', express.static(process.env.UPLOAD_DIR || './uploads'));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/webhook', webhookRouter);
app.use('/api',     messagesRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Boot ─────────────────────────────────────────────────────────────────────
connectDB().then(async () => {
  // Initialise MinIO bucket if MinIO storage is configured
  if (process.env.MEDIA_STORAGE === 'minio') {
    await ensureBucket();
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n🚀  WhatsApp Cloud Capture running on port ${PORT}`);
    console.log(`   Webhook:  http://localhost:${PORT}/webhook`);
    console.log(`   API:      http://localhost:${PORT}/api/messages`);
    console.log(`   Health:   http://localhost:${PORT}/health\n`);
  });
});

export default app;
