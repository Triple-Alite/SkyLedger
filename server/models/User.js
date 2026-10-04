const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
  role: { type: String, enum: ['owner', 'admin', 'dispatcher', 'pilot', 'viewer'], default: 'owner' },
  isActive: { type: Boolean, default: true },
  organizationName: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
  passwordHash: { type: String, required: true, select: false },
  emailVerified: { type: Boolean, default: false },
  emailVerifiedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);