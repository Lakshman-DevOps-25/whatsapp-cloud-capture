import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import { connectDB } from './config/db.js';
import { validateMediaConfig } from './services/mediaService.js';
import webhookRouter  from './routes/webhook.js';
import messagesRouter from './routes/messages.js';

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Serve locally stored media (only active when MEDIA_STORAGE=local)
app.use('/media', express.static(process.env.UPLOAD_DIR || './uploads'));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/webhook', webhookRouter);
app.use('/api',     messagesRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status:        'ok',
    ts:            new Date().toISOString(),
    storage:       process.env.MEDIA_STORAGE      || 'local',
    minioInternal: process.env.MINIO_INTERNAL_URL || null,
    minioPublic:   process.env.MINIO_PUBLIC_URL   || null,
    bucket:        process.env.MINIO_BUCKET        || null,
  });
});

// 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Global unhandled rejection guard ────────────────────────────────────────
// Prevents Node from crashing on any unexpected async error
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled promise rejection (non-fatal):', reason);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  // 1. Connect MongoDB
  await connectDB();

  // 2. Validate media storage config (logs what backend is active)
  //    Does NOT connect to MinIO — just checks env vars are present
  try {
    validateMediaConfig();
  } catch (err) {
    console.error('⚠️  Media config warning:', err.message);
    console.error('   App will start but media storage may not work.\n');
  }

  // NOTE: ensureBucket() is intentionally NOT called here.
  // play.min.io and some MinIO servers reject bucketExists() on startup
  // due to credentials/region issues. The bucket is verified lazily on
  // first actual upload instead — see mediaService.js saveMinIO().

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n🚀  WhatsApp Cloud Capture running on port ${PORT}`);
    console.log(`   Webhook : http://localhost:${PORT}/webhook`);
    console.log(`   API     : http://localhost:${PORT}/api/messages`);
    console.log(`   Health  : http://localhost:${PORT}/health\n`);
  });
}

boot().catch(err => {
  console.error('❌ Fatal boot error:', err.message);
  process.exit(1);
});

export default app;
