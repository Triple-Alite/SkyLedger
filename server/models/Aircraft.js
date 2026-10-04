const mongoose = require('mongoose');

const aircraftSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  manufacturer: { type: String, default: '', trim: true, maxlength: 80 },
  model: { type: String, default: '', trim: true, maxlength: 80 },
  registration: { type: String, default: '', trim: true, maxlength: 40 },
  enduranceMin: { type: Number, required: true, min: 1, max: 1440 },
  isArchived: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

aircraftSchema.index({ owner: 1, registration: 1 }, { unique: true, partialFilterExpression: { registration: { $type: 'string', $gt: '' } } });

module.exports = mongoose.model('Aircraft', aircraftSchema);