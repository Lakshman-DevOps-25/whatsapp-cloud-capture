# WhatsApp Cloud Capture

> **Open-source** · **MIT License** · **Commercial-use ready**  
> Full WhatsApp Cloud API message & media capture built with **Node.js + Express + MongoDB + MinIO**

---

## Features

| Capability | Details |
|---|---|
| ✅ Receive all message types | text, image, video, audio, document, sticker, location, contacts, reactions, interactive replies |
| ✅ Auto-download & store media | Streams inbound media to **local disk** or **MinIO** object storage |
| ✅ Send all message types | text, image, video, audio, document, location, template, interactive buttons/lists |
| ✅ Upload media to WA CDN | Upload a file once → get reusable media ID for any send |
| ✅ Full conversation history | Inbound + outbound stored in MongoDB with delivery status tracking |
| ✅ Contact management | Auto-upsert contacts with message & media counts |
| ✅ REST API | Query messages by contact, type, direction, media |
| ✅ Commercial-use safe | Uses official Meta Cloud API only — no Baileys, no web scraping |

---

## Prerequisites

- Node.js v18+
- MongoDB (local or Atlas)
- MinIO (self-hosted) or any S3-compatible object store
- **Meta Business Account** → WhatsApp Business API access
- A public HTTPS URL for the webhook (use [ngrok](https://ngrok.com) for local dev)

---

## Quick Start

### 1. Start MongoDB + MinIO via Docker

```bash
docker-compose up -d
# MongoDB  → localhost:27017
# MinIO API     → localhost:9000
# MinIO Console → http://localhost:9001  (user: minioadmin / pass: minioadmin)
```

### 2. Install & Configure

```bash
npm install
cp .env.example .env
# Edit .env — fill in Meta credentials and set MEDIA_STORAGE=minio
```

### 3. Run

```bash
npm run dev
```

### 4. Expose webhook for Meta

```bash
npx ngrok http 3000
# Paste https://your-ngrok-url/webhook into Meta Developer Console
```

---

## Meta Developer Setup

1. Go to [developers.facebook.com](https://developers.facebook.com) → Your App → WhatsApp → Configuration
2. Set **Callback URL** to `https://your-ngrok-url/webhook`
3. Set **Verify Token** to the same value as `WA_VERIFY_TOKEN` in your `.env`
4. Subscribe to the **messages** webhook field
5. Use a **System User access token** (not the temporary one) for production

---

## Project Structure

```
src/
├── config/
│   ├── db.js                 MongoDB connection
│   └── minioClient.js        MinIO client singleton + bucket init + URL builder
├── models/
│   ├── Message.js            Full message schema (all types + media sub-doc)
│   └── Contact.js            Contact / conversation tracking
├── routes/
│   ├── webhook.js            Meta webhook (GET verify + POST events)
│   └── messages.js           REST API (read + send)
├── services/
│   ├── whatsappService.js    All send* helpers + uploadMedia
│   └── mediaService.js       Download & store inbound media (local/MinIO)
└── app.js                    Express entry point
docker-compose.yml            MongoDB + MinIO local dev stack
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
| `WA_VERIFY_TOKEN` | ✅ | Your custom webhook verification string |
| `WA_API_VERSION` | No | Graph API version (default v19.0) |
| `MEDIA_STORAGE` | No | `local` (default) or `minio` |
| `UPLOAD_DIR` | No | Local upload path when `MEDIA_STORAGE=local` |
| `MINIO_ENDPOINT` | MinIO only | MinIO server hostname (default `localhost`) |
| `MINIO_PORT` | MinIO only | MinIO port (default `9000`) |
| `MINIO_USE_SSL` | MinIO only | `true` for HTTPS (default `false`) |
| `MINIO_ACCESS_KEY` | MinIO only | MinIO root/access key |
| `MINIO_SECRET_KEY` | MinIO only | MinIO root/secret key |
| `MINIO_BUCKET` | MinIO only | Bucket name (default `whatsapp-media`) |
| `MINIO_PUBLIC_URL` | MinIO only | Public base URL for building object URLs |

---

## MinIO Object Layout

```
whatsapp-media/
└── whatsapp/
    ├── images/       ← image/jpeg, image/png, image/webp, stickers
    ├── videos/       ← video/mp4, video/3gpp
    ├── audio/        ← audio/ogg, audio/mpeg, audio/mp4
    └── documents/    ← application/pdf, .docx, .xlsx, etc.
```

Each file is named `<whatsapp-media-id>.<ext>` (or the original filename for documents).

---

## REST API Reference

### Read

```
GET /api/messages                ?page&limit&type&direction
GET /api/messages/:messageId
GET /api/messages/contact/:phone ?page&limit
GET /api/messages/media          ?type
GET /api/contacts/list
```

### Send

```
POST /api/send/text       { to, text }
POST /api/send/image      { to, url, caption }  OR  multipart: to + caption + file
POST /api/send/video      { to, url, caption }  OR  multipart: to + caption + file
POST /api/send/audio      { to, url }           OR  multipart: to + file
POST /api/send/document   { to, url, caption, fileName }  OR  multipart
POST /api/send/location   { to, latitude, longitude, name, address }
POST /api/send/template   { to, templateName, languageCode, components }
POST /api/send/buttons    { to, bodyText, buttons:[{id,title}], headerText, footerText }
POST /api/upload          multipart: file  →  { mediaId, fileName, mimeType }
```

---

## MongoDB Queries

```js
// Conversation with a contact
db.messages.find({ from: "919876543210" }).sort({ waTimestamp: -1 })

// Media not yet stored in MinIO
db.messages.find({ "media.mediaId": { $exists: true }, "media.downloadedAt": { $exists: false } })

// Get MinIO URL for a message
db.messages.findOne({ messageId: "wamid.xxx" }, { "media.minioUrl": 1 })

// Counts by message type
db.messages.aggregate([{ $group: { _id: "$type", count: { $sum: 1 } } }])
```

---

## License

MIT — free for personal and **commercial use**.

> ⚠️ This project uses the **official Meta WhatsApp Cloud API**. You must comply with [Meta's Platform Terms](https://developers.facebook.com/terms) and WhatsApp's [Business Policy](https://www.whatsapp.com/legal/business-policy/) when using it commercially.
