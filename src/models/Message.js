import mongoose from 'mongoose';

// ─── Media sub-document ───────────────────────────────────────────────────────
const MediaSchema = new mongoose.Schema({
  mediaId:     String,          // WhatsApp media ID (used to download via API)
  mimeType:    String,          // e.g. image/jpeg, video/mp4, audio/ogg
  sha256:      String,          // integrity hash from Meta
  fileSize:    Number,          // bytes
  fileName:    String,          // original filename (documents only)
  caption:     String,          // text caption attached to media
  // After download:
  localPath:   String,          // path on local disk   (MEDIA_STORAGE=local)
  minioKey:    String,          // MinIO object key     (MEDIA_STORAGE=minio)
  minioUrl:    String,          // public/presigned MinIO URL
  downloadedAt: Date,
}, { _id: false });

// ─── Location sub-document ────────────────────────────────────────────────────
const LocationSchema = new mongoose.Schema({
  latitude:  Number,
  longitude: Number,
  name:      String,
  address:   String,
}, { _id: false });

// ─── Button reply sub-document ────────────────────────────────────────────────
const ButtonReplySchema = new mongoose.Schema({
  id:    String,
  title: String,
}, { _id: false });

// ─── Message model ────────────────────────────────────────────────────────────
const MessageSchema = new mongoose.Schema({
  // Identity
  messageId:    { type: String, unique: true, index: true },
  direction:    { type: String, enum: ['inbound', 'outbound'], default: 'inbound' },

  // Parties
  from:         { type: String, index: true },  // phone number (E.164 format)
  to:           { type: String, index: true },  // phone number or WA phone number ID
  contactName:  String,                          // display name from contacts[]

  // Content — only the relevant field(s) will be populated per type
  type: {
    type: String,
    enum: [
      'text',
      'image', 'video', 'audio', 'document', 'sticker',
      'location',
      'contacts',
      'button',          // reply to a template button
      'interactive',     // button/list reply from interactive message
      'template',        // outbound template message
      'reaction',
      'order',
      'unsupported',
      'unknown',   // placeholder created by status webhook before send completes
    ],
    index: true,
  },

  // Text
  body:         String,

  // Media (image / video / audio / document / sticker)
  media:        MediaSchema,

  // Location
  location:     LocationSchema,

  // Button / interactive reply
  buttonReply:  ButtonReplySchema,

  // Reaction
  reaction: {
    messageId: String,   // message being reacted to
    emoji:     String,
  },

  // Delivery status
  status: {
    type: String,
    enum: ['received', 'queued', 'sent', 'delivered', 'read', 'failed', 'deleted'],
    default: 'received',
    index: true,
  },
  errorCode:    String,
  errorMessage: String,

  // Timestamps
  waTimestamp:  { type: Date, index: true },  // timestamp from WhatsApp

  // Context (reply-to)
  contextMessageId: String,   // if this message is a reply

  // Full raw payload for debugging / audit
  rawPayload:   mongoose.Schema.Types.Mixed,

}, { timestamps: true });   // createdAt / updatedAt added automatically

// Compound index for conversation view
MessageSchema.index({ from: 1, waTimestamp: -1 });
MessageSchema.index({ to: 1, waTimestamp: -1 });

export default mongoose.model('Message', MessageSchema);
