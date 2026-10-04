const express = require('express');
const Corridor = require('../models/Corridor');
const FlightPlan = require('../models/FlightPlan');
const ActivityEntry = require('../models/ActivityEntry');
const AirspaceZone = require('../models/AirspaceZone');
const { requireAuth, requireOrganizationRole, requireAirspaceReviewer } = require('../middleware/auth');
const { notifyUser } = require('../lib/notifications');
const { findConflicts, suggestFix } = require('../lib/conflicts');
const { validateAirspaceZone } = require('../lib/airspace');

const router = express.Router();

function toClientFlight(flight, corridorSlug) {
  const value = flight.toObject ? flight.toObject() : flight;
  return {
    _id: String(value._id),
    id: value.letter,
    letter: value.letter,
    corridor: corridorSlug,
    operator: value.operator,
    ncaaId: value.ncaaId || '',
    ownerId: value.owner ? String(value.owner._id || value.owner) : null,
    organizationId: value.organization ? String(value.organization._id || value.organization) : null,
    isDemo: Boolean(value.isDemo),
    aircraft: value.aircraft && value.aircraft.name ? {
      id: String(value.aircraft._id), name: value.aircraft.name,
      registration: value.aircraft.registration, enduranceMin: value.aircraft.enduranceMin,
    } : null,
    payloadDetails: value.payloadDetails || '',
    batteryStartPercent: value.batteryStartPercent,
    batteryReservePercent: value.batteryReservePercent,
    contingencyPlan: value.contingencyPlan || '',
    actualStartMin: value.actualStartMin,
    actualEndMin: value.actualEndMin,
    disruption: value.disruption,
    outcomeNotes: value.outcomeNotes || '',
    feedbackAt: value.feedbackAt,
    internalApprovalStatus: value.internalApprovalStatus || 'pending',
    internalApprovalReviewedBy: value.internalApprovalReviewedBy && value.internalApprovalReviewedBy.name || null,
    internalApprovalReviewedAt: value.internalApprovalReviewedAt || null,
    authorityClearanceStatus: value.authorityClearanceStatus || 'not-requested',
    authorityName: value.authorityName || '',
    authorityReference: value.authorityReference || '',
    authorityValidUntil: value.authorityValidUntil || null,
    authorityRecordedBy: value.authorityRecordedBy && value.authorityRecordedBy.name || null,
    authorityRecordedAt: value.authorityRecordedAt || null,
    from: value.from,
    to: value.to,
    payload: value.payload,
    band: value.band,
    flightDate: value.flightDate || '',
    waypoints: (value.waypoints || []).map((point) => ({ lat: point.lat, lng: point.lng })),
    startMin: value.startMin,
    endMin: value.endMin,
    createdAt: value.createdAt,
  };
}

function annotateFlights(flights, corridorSlug) {
  return flights.map((flight) => {
    const conflicts = findConflicts(flight, flights, flight._id);
    return {
      ...toClientFlight(flight, corridorSlug),
      isConflict: conflicts.length > 0,
      conflictsWith: conflicts.map((conflict) => conflict.letter),
      suggestedFix: conflicts.length ? suggestFix(flight, flights, flight._id) : null,
    };
  });
}

async function loadCorridor(slug) {
  const corridor = await Corridor.findOne({ slug });
  if (!corridor) return null;
  const flights = await FlightPlan.find({ corridor: corridor._id })
    .populate('aircraft', 'name registration enduranceMin')
    .populate('internalApprovalReviewedBy', 'name')
    .populate('authorityRecordedBy', 'name')
    .sort({ createdAt: 1, letter: 1 });
  return { corridor, flights, annotated: annotateFlights(flights, corridor.slug) };
}

function createActivity(io, corridor, text) {
  return ActivityEntry.create({ corridor: corridor._id, text }).then((entry) => {
    const activity = { _id: String(entry._id), text: entry.text, createdAt: entry.createdAt };
    io.to(corridor.slug).emit('activity:new', { slug: corridor.slug, activity });
    return activity;
  });
}

function slugBase(label) {
  return label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-+$/g, '') || 'corridor';
}

router.post('/', requireAuth, requireOrganizationRole('owner', 'admin', 'dispatcher'), async (req, res, next) => {
  try {
    const label = typeof (req.body || {}).label === 'string' ? req.body.label.trim() : '';
    if (label.length < 3 || label.length > 80) {
      return res.status(400).json({ error: 'Corridor name must be 3 to 80 characters.' });
    }

    const base = slugBase(label);
    let slug = base;
    let suffix = 2;
    while (await Corridor.exists({ slug })) slug = base.slice(0, 60) + '-' + suffix++;

    const corridor = await Corridor.create({ slug, label, createdBy: req.session.userId });
    const value = { _id: String(corridor._id), slug: corridor.slug, label: corridor.label, createdAt: corridor.createdAt };
    req.app.get('io').emit('corridor:created', value);
    res.status(201).json(value);
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'That corridor name was just created. Try again.' });
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const corridors = await Corridor.find().sort({ slug: 1 }).select('slug label createdAt');
    res.json(corridors);
  } catch (error) {
    next(error);
  }
});

router.delete('/:slug', requireAuth, requireOrganizationRole('owner', 'admin'), async (req, res, next) => {
  try {
    const corridor = await Corridor.findOne({ slug: req.params.slug });
    if (!corridor) return res.status(404).json({ error: 'Location not found.' });

    await Promise.all([
      FlightPlan.deleteMany({ corridor: corridor._id }),
      AirspaceZone.deleteMany({ corridor: corridor._id }),
      ActivityEntry.deleteMany({ corridor: corridor._id }),
    ]);
    await corridor.deleteOne();

    req.app.get('io').emit('corridor:removed', { slug: corridor.slug, label: corridor.label });
    res.json({ slug: corridor.slug, label: corridor.label });
  } catch (error) {
    next(error);
  }
});

router.get('/:slug/flights', async (req, res, next) => {
  try {
    const result = await loadCorridor(req.params.slug);
    if (!result) return res.status(404).json({ error: 'Corridor not found.' });
    res.json(result.annotated);
  } catch (error) {
    next(error);
  }
});

router.get('/:slug/activity', async (req, res, next) => {
  try {
    const corridor = await Corridor.findOne({ slug: req.params.slug });
    if (!corridor) return res.status(404).json({ error: 'Corridor not found.' });
    const entries = await ActivityEntry.find({ corridor: corridor._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('text createdAt');
    res.json(entries.map((entry) => ({ _id: String(entry._id), text: entry.text, createdAt: entry.createdAt })));
  } catch (error) {
    next(error);
  }
});

router.get('/:slug/airspace', async (req, res, next) => {
  try {
    const corridor = await Corridor.findOne({ slug: req.params.slug }).select('_id');
    if (!corridor) return res.status(404).json({ error: 'Corridor not found.' });
    const zones = await AirspaceZone.find({ corridor: corridor._id, reviewStatus: 'approved' })
      .populate('reviewedBy', 'name').sort({ sourceCheckedAt: -1 });
    res.json(zones.map((zone) => ({
      id: String(zone._id), name: zone.name, category: zone.category,
      geometry: zone.geometry, sourceName: zone.sourceName, sourceUrl: zone.sourceUrl,
      sourceCheckedAt: zone.sourceCheckedAt, sourceType: zone.sourceType,
      reviewStatus: zone.reviewStatus, reviewedAt: zone.reviewedAt,
      reviewedBy: zone.reviewedBy ? zone.reviewedBy.name : null, verified: false,
    })));
  } catch (error) {
    next(error);
  }
});

router.post('/:slug/airspace', requireAuth, requireOrganizationRole('owner', 'admin', 'dispatcher'), async (req, res, next) => {
  try {
    const result = validateAirspaceZone(req.body || {});
    if (result.error) return res.status(400).json({ error: result.error });
    const corridor = await Corridor.findOne({ slug: req.params.slug });
    if (!corridor) return res.status(404).json({ error: 'Corridor not found.' });
    const zone = await AirspaceZone.create({
      corridor: corridor._id,
      createdBy: req.session.userId,
      name: result.value.name.trim(),
      category: result.value.category,
      geometry: result.value.geometry,
      sourceName: result.value.sourceName,
      sourceUrl: result.value.sourceUrl,
      sourceCheckedAt: result.value.sourceCheckedAt,
      sourceType: 'community',
      reviewStatus: 'pending',
    });
    const io = req.app.get('io');
    const reviewers = (process.env.AIRSPACE_REVIEWER_EMAILS || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
    const reviewerAccounts = reviewers.length ? await require('../models/User').find({ email: { $in: reviewers } }).select('_id') : [];
    for (const reviewer of reviewerAccounts) {
      await notifyUser(io, reviewer._id, {
        type: 'airspace', title: 'Airspace source needs review',
        message: zone.name + ' was submitted to ' + corridor.label + ' with a cited source.',
        href: '/',
      });
    }
    await createActivity(io, corridor, 'A community-sourced airspace overlay was submitted for review: ' + zone.name + '.');
    res.status(201).json({ id: String(zone._id), name: zone.name, category: zone.category, sourceCheckedAt: zone.sourceCheckedAt, reviewStatus: zone.reviewStatus, verified: false });
  } catch (error) {
    next(error);
  }
});

router.get('/:slug/airspace/:id', requireAuth, requireAirspaceReviewer, async (req, res, next) => {
  try {
    const zone = await AirspaceZone.findOne({ _id: req.params.id, reviewStatus: 'pending' }).populate('corridor', 'slug label');
    if (!zone || zone.corridor.slug !== req.params.slug) return res.status(404).json({ error: 'Pending airspace entry not found.' });
    res.json({
      id: String(zone._id), corridor: zone.corridor.slug, corridorLabel: zone.corridor.label,
      name: zone.name, category: zone.category, geometry: zone.geometry,
      sourceName: zone.sourceName, sourceUrl: zone.sourceUrl, sourceCheckedAt: zone.sourceCheckedAt,
      sourceType: zone.sourceType, reviewStatus: zone.reviewStatus,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:slug/airspace-review', requireAuth, requireAirspaceReviewer, async (req, res, next) => {
  try {
    const corridor = await Corridor.findOne({ slug: req.params.slug }).select('_id');
    if (!corridor) return res.status(404).json({ error: 'Corridor not found.' });
    const zones = await AirspaceZone.find({ corridor: corridor._id, reviewStatus: 'pending' })
      .populate('createdBy', 'name organizationName').sort({ createdAt: 1 });
    res.json(zones.map((zone) => ({
      id: String(zone._id), name: zone.name, category: zone.category,
      sourceName: zone.sourceName, sourceUrl: zone.sourceUrl,
      sourceCheckedAt: zone.sourceCheckedAt, sourceType: zone.sourceType,
      submittedBy: zone.createdBy ? zone.createdBy.name : 'Unknown operator',
    })));
  } catch (error) {
    next(error);
  }
});

router.patch('/:slug/airspace/:id/review', requireAuth, requireAirspaceReviewer, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!['approve', 'reject'].includes(body.decision)) return res.status(400).json({ error: 'Choose approve or reject.' });
    if (body.reviewNotes != null && (typeof body.reviewNotes !== 'string' || body.reviewNotes.length > 500)) return res.status(400).json({ error: 'Review notes must be at most 500 characters.' });
    if (body.sourceType != null && !['community', 'authority'].includes(body.sourceType)) return res.status(400).json({ error: 'Choose community or authority source.' });
    const zone = await AirspaceZone.findById(req.params.id);
    if (!zone || String(zone.corridor) !== String((await Corridor.findOne({ slug: req.params.slug }).select('_id'))?._id)) {
      return res.status(404).json({ error: 'Airspace entry not found.' });
    }
    if (zone.reviewStatus !== 'pending') return res.status(409).json({ error: 'This airspace entry has already been reviewed.' });
    zone.reviewStatus = body.decision === 'approve' ? 'approved' : 'rejected';
    zone.sourceType = body.sourceType || 'community';
    zone.reviewedBy = req.user._id;
    zone.reviewedAt = new Date();
    zone.reviewNotes = (body.reviewNotes || '').trim();
    await zone.save();
    const corridor = await Corridor.findById(zone.corridor);
    req.app.get('io').to(corridor.slug).emit('airspace:created', { slug: corridor.slug, id: String(zone._id) });
    await createActivity(req.app.get('io'), corridor, 'Airspace overlay ' + zone.name + ' was ' + zone.reviewStatus + ' by a configured reviewer.');
    const submitter = await require('../models/User').findById(zone.createdBy).select('_id');
    if (submitter) await notifyUser(req.app.get('io'), submitter._id, {
      type: 'airspace', title: 'Airspace overlay reviewed',
      message: zone.name + ' was ' + zone.reviewStatus + '.' + (zone.reviewNotes ? ' Reviewer note: ' + zone.reviewNotes : ''),
      href: '/',
    });
    res.json({ id: String(zone._id), reviewStatus: zone.reviewStatus, sourceType: zone.sourceType, reviewedAt: zone.reviewedAt, verified: false });
  } catch (error) {
    next(error);
  }
});

router.get('/:slug/reliability', async (req, res, next) => {
  try {
    const corridor = await Corridor.findOne({ slug: req.params.slug });
    if (!corridor) return res.status(404).json({ error: 'Corridor not found.' });
    const completed = await FlightPlan.find({
      corridor: corridor._id,
      actualStartMin: { $ne: null },
      actualEndMin: { $ne: null },
    }).select('startMin endMin actualStartMin actualEndMin disruption');
    const disruptionCounts = {};
    const departureByHour = {};
    let onTime = 0;
    let totalArrivalDelay = 0;
    for (const flight of completed) {
      const delay = flight.actualEndMin - flight.endMin;
      totalArrivalDelay += delay;
      if (Math.abs(flight.actualStartMin - flight.startMin) <= 5 && Math.abs(delay) <= 5) onTime += 1;
      const hour = Math.floor(flight.startMin / 60);
      if (!departureByHour[hour]) departureByHour[hour] = { count: 0, totalDelayMin: 0 };
      departureByHour[hour].count += 1;
      departureByHour[hour].totalDelayMin += flight.actualStartMin - flight.startMin;
      if (flight.disruption && flight.disruption !== 'none') {
        disruptionCounts[flight.disruption] = (disruptionCounts[flight.disruption] || 0) + 1;
      }
    }
    res.json({
      completedFlights: completed.length,
      onTimePercent: completed.length ? Math.round((onTime / completed.length) * 1000) / 10 : null,
      averageArrivalDelayMin: completed.length ? Math.round((totalArrivalDelay / completed.length) * 10) / 10 : null,
      disruptions: disruptionCounts,
      departureShiftByHour: Object.entries(departureByHour).map(([hour, value]) => ({
        hour: Number(hour), samples: value.count,
        averageMinutes: Math.round((value.totalDelayMin / value.count) * 10) / 10,
      })),
      asOf: new Date(),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:slug/reset', requireAuth, requireOrganizationRole('owner', 'admin'), async (req, res, next) => {
  try {
    const result = await loadCorridor(req.params.slug);
    if (!result) return res.status(404).json({ error: 'Corridor not found.' });
    const { corridor } = result;
    const oldFlights = await FlightPlan.find({ corridor: corridor._id, isDemo: true });
    await FlightPlan.deleteMany({ corridor: corridor._id, isDemo: true });

    let restored = [];
    if (corridor.slug === 'kaduna-northwest') {
      const { KADUNA_SEED } = require('../seed');
      restored = await FlightPlan.insertMany(KADUNA_SEED.map((flight) => ({ ...flight, corridor: corridor._id, isDemo: true })));
    }

    const message = 'Demo data reset in ' + corridor.label + '.';
    const activity = await createActivity(req.app.get('io'), corridor, message);
    const snapshot = await loadCorridor(corridor.slug);
    for (const oldFlight of oldFlights) {
      req.app.get('io').to(corridor.slug).emit('flight:cancelled', {
        slug: corridor.slug,
        flight: toClientFlight(oldFlight, corridor.slug),
        flights: snapshot.annotated,
      });
    }
    for (const flight of restored) {
      req.app.get('io').to(corridor.slug).emit('flight:created', {
        slug: corridor.slug,
        flight: toClientFlight(flight, corridor.slug),
        flights: snapshot.annotated,
      });
    }

    res.json({ flights: snapshot.annotated, activity });
  } catch (error) {
    next(error);
  }
});

module.exports = { router, annotateFlights, toClientFlight, loadCorridor, slugBase };