import mongoose from 'mongoose';

const MediaSchema = new mongoose.Schema({
  mediaId:      String,
  mimeType:     String,
  sha256:       String,
  fileSize:     Number,
  fileName:     String,
  caption:      String,
  localPath:    String,
  minioKey:     String,
  minioUrl:     String,
  downloadedAt: Date,
}, { _id: false });

const LocationSchema = new mongoose.Schema({
  latitude:  Number,
  longitude: Number,
  name:      String,
  address:   String,
}, { _id: false });

const ButtonReplySchema = new mongoose.Schema({
  id:    String,
  title: String,
}, { _id: false });

const MessageSchema = new mongoose.Schema({
  messageId:    { type: String, unique: true, index: true },
  direction:    { type: String, enum: ['inbound', 'outbound'], default: 'inbound' },
  from:         { type: String, index: true },
  to:           { type: String, index: true },
  contactName:  String,
  type:         { type: String, enum: ['text','image','video','audio','document','sticker','location','contacts','button','interactive','template','reaction','order','unsupported'], index: true },
  body:         String,
  media:        MediaSchema,
  location:     LocationSchema,
  buttonReply:  ButtonReplySchema,
  reaction:     { messageId: String, emoji: String },
  status:       { type: String, enum: ['received','queued','sent','delivered','read','failed','deleted'], default: 'received', index: true },
  errorCode:    String,
  errorMessage: String,
  waTimestamp:      { type: Date, index: true },
  contextMessageId: String,
  rawPayload:       mongoose.Schema.Types.Mixed,
}, { timestamps: true });

MessageSchema.index({ from: 1, waTimestamp: -1 });
MessageSchema.index({ to: 1, waTimestamp: -1 });

export default mongoose.model('Message', MessageSchema);
