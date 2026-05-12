import mongoose from 'mongoose';

const ContactSchema = new mongoose.Schema({
  phone:         { type: String, unique: true, index: true }, // E.164
  waId:          String,
  name:          String,
  firstSeen:     { type: Date, default: Date.now },
  lastSeen:      Date,
  messageCount:  { type: Number, default: 0 },
  mediaCount:    { type: Number, default: 0 },
}, { timestamps: true });

export default mongoose.model('Contact', ContactSchema);
