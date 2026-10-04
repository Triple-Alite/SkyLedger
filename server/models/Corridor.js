const mongoose = require('mongoose');

const corridorSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true, trim: true },
  label: { type: String, required: true, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Corridor', corridorSchema);