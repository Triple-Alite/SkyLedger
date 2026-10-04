const mongoose = require('mongoose');

const activityEntrySchema = new mongoose.Schema({
  corridor: { type: mongoose.Schema.Types.ObjectId, ref: 'Corridor', required: true, index: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model('ActivityEntry', activityEntrySchema);