# WhatsApp Cloud Capture

> **Open-source** · **MIT License** · **Commercial-use ready**  
> Full WhatsApp Cloud API message & media capture — **Node.js + Express + MongoDB + MinIO**

---

## Features

| Capability | Details |
|---|---|
| ✅ Receive all message types | text, image, video, audio, document, sticker, location, contacts, reactions, interactive replies |
| ✅ Auto-download & store media | Streams inbound media to **local disk** or **MinIO** |
| ✅ Send all message types | text, image, video, audio, document, location, template, interactive buttons/lists |
| ✅ Upload media to WA CDN | Upload once → reusable media ID |
| ✅ Full conversation history | Inbound + outbound in MongoDB with delivery status |
| ✅ Contact management | Auto-upsert contacts with message & media counts |
| ✅ REST API | Query messages by contact, type, direction, media |
| ✅ Commercial-use safe | Official Meta Cloud API only — no Baileys, no web scraping |

---

## The Two MinIO URLs — Important

This project uses **two separate addresses** for MinIO:

| Variable | Purpose | Example value |
|---|---|---|
| `MINIO_INTERNAL_URL` | How **this Node.js server** connects to MinIO (private/internal network) | `http://minio:9000` (Docker) · `http://localhost:9000` (same machine) |
| `MINIO_PUBLIC_URL` | How the **internet** fetches stored media (browsers, WhatsApp previews) | `https://media.yourdomain.com` · `http://203.0.113.10:9000` |

> ⚠️ **Never set `MINIO_PUBLIC_URL` to `localhost`** — browsers and WhatsApp servers cannot reach it.  
> Your MinIO port (default `9000`) must be open in your firewall / cloud security group.

---

## Prerequisites

- Node.js v18+
- MongoDB (local or Atlas)
- MinIO — self-hosted on same server, VPS, or Docker
- **Meta Business Account** → WhatsApp Business API access
- A public HTTPS URL for the webhook (use [ngrok](https://ngrok.com) locally)

---

## Quick Start

### 1. Start MongoDB + MinIO

```bash
docker-compose up -d
# MongoDB API      → localhost:27017
# MinIO API        → localhost:9000   (also accessible on YOUR_PUBLIC_IP:9000)
# MinIO Console UI → http://localhost:9001
```

### 2. Configure

```bash
npm install
cp .env.example .env
```

Edit `.env` — the critical MinIO settings:

```env
MEDIA_STORAGE=minio

# Internal: how Node.js connects to MinIO
MINIO_INTERNAL_URL=http://localhost:9000      # same machine
# MINIO_INTERNAL_URL=http://minio:9000        # if Node.js runs inside Docker too

# Public: how the internet accesses media files
MINIO_PUBLIC_URL=http://203.0.113.10:9000     # your server's public IP
# MINIO_PUBLIC_URL=https://media.yourdomain.com  # with HTTPS reverse proxy
```

### 3. Run

```bash
npm run dev
```

### 4. Expose webhook for Meta

```bash
npx ngrok http 3000
# Set https://xxx.ngrok.io/webhook in Meta Developer Console
```

---

## Project Structure

```
src/
├── config/
│   ├── db.js               MongoDB connection
│   └── minioClient.js      MinIO singleton — parses MINIO_INTERNAL_URL for SDK,
│                           uses MINIO_PUBLIC_URL to build object URLs
├── models/
│   ├── Message.js          Full schema (all types + media sub-doc)
│   └── Contact.js          Contact / conversation tracking
├── routes/
│   ├── webhook.js          Meta webhook (GET verify + POST events)
│   └── messages.js         REST API (read + send)
├── services/
│   ├── whatsappService.js  All send* helpers + uploadMedia
│   └── mediaService.js     Download & store inbound media (local / MinIO)
└── app.js                  Express entry point
docker-compose.yml          MongoDB + MinIO dev/prod stack
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default 3000) |
| `MONGODB_URI` | ✅ | MongoDB connection string |
| `WA_PHONE_NUMBER_ID` | ✅ | From Meta Developer Dashboard |
| `WA_BUSINESS_ACCOUNT_ID` | ✅ | From Meta Developer Dashboard |
| `WA_ACCESS_TOKEN` | ✅ | System User permanent token |
| `WA_VERIFY_TOKEN` | ✅ | Custom webhook verification string |
| `WA_API_VERSION` | No | Graph API version (default `v19.0`) |
| `MEDIA_STORAGE` | No | `local` (default) or `minio` |
| `UPLOAD_DIR` | No | Local upload path (default `./uploads`) |
| `MINIO_INTERNAL_URL` | MinIO | Internal URL Node.js uses to connect to MinIO |
| `MINIO_PUBLIC_URL` | MinIO ✅ | **Public URL** internet uses to fetch media — must not be localhost |
| `MINIO_ACCESS_KEY` | MinIO | MinIO access key |
| `MINIO_SECRET_KEY` | MinIO | MinIO secret key |
| `MINIO_BUCKET` | MinIO | Bucket name (default `whatsapp-media`) |

---

## Deployment Scenarios

### Scenario A — App + MinIO on the same VPS (most common)

```
Internet ──→ your-server-ip:3000  (Node.js / webhook)
         ──→ your-server-ip:9000  (MinIO public media access)

.env:
  MINIO_INTERNAL_URL=http://localhost:9000
  MINIO_PUBLIC_URL=http://your-server-ip:9000
```

### Scenario B — App + MinIO in Docker Compose (same network)

```
Internet ──→ your-server-ip:3000  (app container)
         ──→ your-server-ip:9000  (minio container)

.env / docker-compose env:
  MINIO_INTERNAL_URL=http://minio:9000       ← Docker service name
  MINIO_PUBLIC_URL=http://your-server-ip:9000
```

### Scenario C — HTTPS with Nginx reverse proxy (recommended for production)

```
Internet ──→ https://api.yourdomain.com     → Node.js :3000
         ──→ https://media.yourdomain.com   → MinIO :9000

.env:
  MINIO_INTERNAL_URL=http://localhost:9000
  MINIO_PUBLIC_URL=https://media.yourdomain.com
```

### Scenario D — Local dev with ngrok

```bash
# Terminal 1 — tunnel for webhook
ngrok http 3000   # → https://abc.ngrok.io/webhook  (for Meta)

# Terminal 2 — tunnel for MinIO (only if you need public media URLs locally)
ngrok http 9000   # → https://xyz.ngrok.io

.env:
  MINIO_INTERNAL_URL=http://localhost:9000
  MINIO_PUBLIC_URL=https://xyz.ngrok.io
```

---

## MinIO Object Layout

```
whatsapp-media/
└── whatsapp/
    ├── images/       ← image/jpeg, png, webp, gif, stickers
    ├── videos/       ← video/mp4, 3gpp
    ├── audio/        ← audio/ogg, mpeg, mp4, aac
    └── documents/    ← pdf, docx, xlsx, etc.
```

Each file: `<whatsapp-media-id>.<ext>` or original filename for documents.

Public URL example:
```
https://media.yourdomain.com/whatsapp-media/whatsapp/images/wamid.abc123.jpg
```

---

## REST API

### Read
```
GET /api/messages                  ?page&limit&type&direction
GET /api/messages/:messageId
GET /api/messages/contact/:phone   ?page&limit
GET /api/messages/media            ?type
GET /api/contacts/list
```

### Send
```
POST /api/send/text       { to, text }
POST /api/send/image      { to, url, caption } | multipart(to, caption, file)
POST /api/send/video      { to, url, caption } | multipart(to, caption, file)
POST /api/send/audio      { to, url }          | multipart(to, file)
POST /api/send/document   { to, url, caption, fileName } | multipart
POST /api/send/location   { to, latitude, longitude, name, address }
POST /api/send/template   { to, templateName, languageCode, components }
POST /api/send/buttons    { to, bodyText, buttons:[{id,title}] }
POST /api/upload          multipart(file) → { mediaId, fileName, mimeType }
```

---

## MongoDB Queries

```js
// Messages with media, showing MinIO URL
db.messages.find({ "media.minioUrl": { $exists: true } }, { "media.minioUrl": 1, from: 1 })

// Media not yet uploaded to MinIO
db.messages.find({ "media.mediaId": { $exists: true }, "media.downloadedAt": { $exists: false } })

// Count by type
db.messages.aggregate([{ $group: { _id: "$type", count: { $sum: 1 } } }])
```

---

## License

MIT — free for personal and **commercial use**.

> ⚠️ Requires compliance with [Meta's Platform Terms](https://developers.facebook.com/terms) and WhatsApp's [Business Policy](https://www.whatsapp.com/legal/business-policy/).
