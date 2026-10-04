const mongoose = require('mongoose');

const airspaceZoneSchema = new mongoose.Schema({
  corridor: { type: mongoose.Schema.Types.ObjectId, ref: 'Corridor', required: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  category: { type: String, required: true, enum: ['restricted', 'no-fly', 'caution'] },
  geometry: { type: mongoose.Schema.Types.Mixed, required: true },
  sourceName: { type: String, required: true, trim: true, maxlength: 120 },
  sourceUrl: { type: String, required: true, trim: true, maxlength: 500 },
  sourceCheckedAt: { type: Date, required: true },
  sourceType: { type: String, enum: ['community', 'authority'], default: 'community' },
  reviewStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  reviewNotes: { type: String, default: '', trim: true, maxlength: 500 },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('AirspaceZone', airspaceZoneSchema);