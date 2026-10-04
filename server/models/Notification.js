const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['invite', 'proposal', 'schedule', 'airspace'], required: true },
  title: { type: String, required: true, maxlength: 120 },
  message: { type: String, required: true, maxlength: 500 },
  href: { type: String, default: '/' },
  readAt: { type: Date, default: null },
  emailStatus: { type: String, enum: ['not-configured', 'queued', 'sent', 'failed'], default: 'not-configured' },
  createdAt: { type: Date, default: Date.now, index: true },
});

notificationSchema.index({ recipient: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);