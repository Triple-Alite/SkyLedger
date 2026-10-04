const mongoose = require('mongoose');

const conflictProposalSchema = new mongoose.Schema({
  corridor: { type: mongoose.Schema.Types.ObjectId, ref: 'Corridor', required: true, index: true },
  proposer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  proposerFlight: { type: mongoose.Schema.Types.ObjectId, ref: 'FlightPlan', required: true },
  recipientFlight: { type: mongoose.Schema.Types.ObjectId, ref: 'FlightPlan', required: true },
  proposedBand: { type: String, required: true, enum: ['200ft', '300ft', '400ft', '500ft'] },
  proposedStartMin: { type: Number, required: true, min: 0 },
  proposedEndMin: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['pending', 'accepted', 'declined', 'stale'], default: 'pending', index: true },
  createdAt: { type: Date, default: Date.now },
  respondedAt: { type: Date, default: null },
});

conflictProposalSchema.index({ proposerFlight: 1, recipientFlight: 1, status: 1 });

module.exports = mongoose.model('ConflictProposal', conflictProposalSchema);