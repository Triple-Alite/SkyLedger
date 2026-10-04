const mongoose = require('mongoose');

const waypointSchema = new mongoose.Schema({
  lat: { type: Number, required: true, min: -90, max: 90 },
  lng: { type: Number, required: true, min: -180, max: 180 },
}, { _id: false });

const flightPlanSchema = new mongoose.Schema({
  corridor: { type: mongoose.Schema.Types.ObjectId, ref: 'Corridor', required: true, index: true },
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  clientRequestId: { type: String, default: undefined },
  internalApprovalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  internalApprovalReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  internalApprovalReviewedAt: { type: Date, default: null },
  internalApprovalNotes: { type: String, default: '', trim: true, maxlength: 500 },
  authorityClearanceStatus: { type: String, enum: ['not-requested', 'pending', 'cleared', 'denied'], default: 'not-requested', index: true },
  authorityName: { type: String, default: '', trim: true, maxlength: 120 },
  authorityReference: { type: String, default: '', trim: true, maxlength: 120 },
  authorityValidUntil: { type: Date, default: null },
  authorityNotes: { type: String, default: '', trim: true, maxlength: 500 },
  authorityRecordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  authorityRecordedAt: { type: Date, default: null },
  aircraft: { type: mongoose.Schema.Types.ObjectId, ref: 'Aircraft', default: null },
  isDemo: { type: Boolean, default: false },
  letter: { type: String, required: true, unique: true },
  operator: { type: String, required: true, trim: true },
  ncaaId: { type: String, default: '', trim: true },
  from: { type: String, required: true, trim: true },
  to: { type: String, required: true, trim: true },
  payload: { type: String, required: true, enum: ['medical', 'agriculture', 'security', 'cargo'] },
  band: { type: String, required: true, enum: ['200ft', '300ft', '400ft', '500ft'] },
  flightDate: { type: String, default: '' },
  waypoints: { type: [waypointSchema], default: [] },
  payloadDetails: { type: String, default: '', trim: true, maxlength: 200 },
  batteryStartPercent: { type: Number, min: 0, max: 100, default: null },
  batteryReservePercent: { type: Number, min: 0, max: 100, default: null },
  contingencyPlan: { type: String, default: '', trim: true, maxlength: 500 },
  actualStartMin: { type: Number, min: 0, max: 1439, default: null },
  actualEndMin: { type: Number, min: 1, max: 1439, default: null },
  disruption: { type: String, enum: ['none', 'weather', 'technical', 'airspace', 'delay', 'other'], default: null },
  outcomeNotes: { type: String, default: '', trim: true, maxlength: 500 },
  feedbackAt: { type: Date, default: null },
  startMin: { type: Number, required: true, min: 0 },
  endMin: { type: Number, required: true, min: 1 },
  createdAt: { type: Date, default: Date.now },
});

flightPlanSchema.index({ corridor: 1, band: 1, startMin: 1, endMin: 1 });
flightPlanSchema.index({ owner: 1, corridor: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });

module.exports = mongoose.model('FlightPlan', flightPlanSchema);