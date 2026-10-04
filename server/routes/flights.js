const express = require('express');
const mongoose = require('mongoose');
const Corridor = require('../models/Corridor');
const FlightPlan = require('../models/FlightPlan');
const Aircraft = require('../models/Aircraft');
const Counter = require('../models/Counter');
const ActivityEntry = require('../models/ActivityEntry');
const ConflictProposal = require('../models/ConflictProposal');
const {
  requireAuth, requireOrganizationRole, canReviewFlightPlans, isFlightAuthorityReviewer,
} = require('../middleware/auth');
const { findConflicts, suggestFix } = require('../lib/conflicts');
const { scheduleFromFix, proposalResolvesConflicts } = require('../lib/proposals');
const { notifyUser } = require('../lib/notifications');
const { annotateFlights, loadCorridor, toClientFlight } = require('./corridors');

const router = express.Router();
const PAYLOADS = new Set(['medical', 'agriculture', 'security', 'cargo']);
const BANDS = new Set(['200ft', '300ft', '400ft', '500ft']);
const DISRUPTIONS = new Set(['none', 'weather', 'technical', 'airspace', 'delay', 'other']);
const AUTHORITY_STATUSES = new Set(['not-requested', 'pending', 'cleared', 'denied']);

function validateInternalApproval(body) {
  if (!['approved', 'rejected'].includes(body.status)) return 'Choose approved or rejected.';
  if (body.notes != null && (typeof body.notes !== 'string' || body.notes.length > 500)) return 'Review notes must be at most 500 characters.';
  return null;
}

function validateAuthorityRecord(body, flightDate) {
  if (!AUTHORITY_STATUSES.has(body.status)) return 'Choose a valid authority status.';
  const authorityName = typeof body.authorityName === 'string' ? body.authorityName.trim() : '';
  const authorityReference = typeof body.authorityReference === 'string' ? body.authorityReference.trim() : '';
  if (body.status !== 'not-requested' && !authorityName) return 'Enter the aviation authority name.';
  if (['cleared', 'denied'].includes(body.status) && !authorityReference) return 'Enter the authority decision reference.';
  if (authorityName.length > 120 || authorityReference.length > 120) return 'Authority name and reference must be at most 120 characters.';
  if (body.notes != null && (typeof body.notes !== 'string' || body.notes.length > 500)) return 'Authority notes must be at most 500 characters.';

  let validUntil = null;
  if (body.validUntil) {
    validUntil = new Date(body.validUntil);
    if (Number.isNaN(validUntil.getTime())) return 'Enter a valid clearance expiry date.';
    if (flightDate && validUntil.toISOString().slice(0, 10) < flightDate) return 'Clearance expiry cannot be before the flight date.';
  }

  return null;
}

function resetFlightDecisions(flight) {
  const previous = {
    internalApprovalStatus: flight.internalApprovalStatus || 'pending',
    authorityClearanceStatus: flight.authorityClearanceStatus || 'not-requested',
    authorityName: flight.authorityName || '',
    authorityReference: flight.authorityReference || '',
  };
  flight.internalApprovalStatus = 'pending';
  flight.internalApprovalReviewedBy = null;
  flight.internalApprovalReviewedAt = null;
  flight.internalApprovalNotes = '';
  flight.authorityClearanceStatus = 'not-requested';
  flight.authorityName = '';
  flight.authorityReference = '';
  flight.authorityValidUntil = null;
  flight.authorityNotes = '';
  flight.authorityRecordedBy = null;
  flight.authorityRecordedAt = null;
  return previous;
}

function decisionResetNote(previous) {
  let note = 'Team approval reopened after a schedule change (previous status: ' + previous.internalApprovalStatus + ').';
  if (previous.authorityClearanceStatus !== 'not-requested') {
    note += ' Previous authority status ' + previous.authorityClearanceStatus
      + (previous.authorityName ? ' from ' + previous.authorityName : '')
      + (previous.authorityReference ? ' (reference ' + previous.authorityReference + ')' : '')
      + ' was superseded; obtain a decision for the revised plan.';
  }
  return note;
}

function validateFlight(body) {
  const required = ['operator', 'from', 'to'];
  for (const field of required) {
    if (typeof body[field] !== 'string' || !body[field].trim()) return field + ' is required.';
  }
  if (body.ncaaId != null && typeof body.ncaaId !== 'string') return 'ncaaId must be text.';
  if (body.clientRequestId != null && (typeof body.clientRequestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.clientRequestId))) return 'Invalid client request ID.';
  if (!PAYLOADS.has(body.payload)) return 'payload is invalid.';
  if (!BANDS.has(body.band)) return 'band is invalid.';
    const parsedDate = typeof body.flightDate === 'string' ? new Date(body.flightDate + 'T00:00:00.000Z') : null;
    if (!parsedDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.flightDate)
      || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== body.flightDate) {
    return 'A valid flight date is required.';
  }
  if (!Array.isArray(body.waypoints) || body.waypoints.length < 2 || body.waypoints.length > 20
      || body.waypoints.some((point) => !Number.isFinite(point.lat) || !Number.isFinite(point.lng)
        || point.lat < -90 || point.lat > 90 || point.lng < -180 || point.lng > 180)) {
    return 'Add between 2 and 20 valid map waypoints.';
  }
  if (body.aircraftId && !mongoose.Types.ObjectId.isValid(body.aircraftId)) return 'Select a valid aircraft.';
  if (body.payloadDetails != null && (typeof body.payloadDetails !== 'string' || body.payloadDetails.length > 200)) return 'Payload details must be at most 200 characters.';
  for (const field of ['batteryStartPercent', 'batteryReservePercent']) {
    if (body[field] != null && (!Number.isInteger(body[field]) || body[field] < 0 || body[field] > 100)) {
      return field + ' must be a whole number from 0 to 100.';
    }
  }
  if (body.contingencyPlan != null && (typeof body.contingencyPlan !== 'string' || body.contingencyPlan.length > 500)) return 'Contingency plan must be at most 500 characters.';
  if (!Number.isInteger(body.startMin) || !Number.isInteger(body.endMin)
      || body.startMin < 0 || body.endMin > 1439 || body.endMin <= body.startMin) {
    return 'The flight time must be a valid same-day interval.';
  }
  return null;
}

function validateFeedback(body) {
  if (!Number.isInteger(body.actualStartMin) || !Number.isInteger(body.actualEndMin)
      || body.actualStartMin < 0 || body.actualEndMin > 1439 || body.actualEndMin <= body.actualStartMin) {
    return 'Enter a valid same-day actual departure and arrival.';
  }
  if (!DISRUPTIONS.has(body.disruption)) return 'Select a valid disruption category.';
  if (body.outcomeNotes != null && (typeof body.outcomeNotes !== 'string' || body.outcomeNotes.length > 500)) {
    return 'Outcome notes must be at most 500 characters.';
  }
  return null;
}

function letterFor(sequence) {
  let value = sequence;
  let letter = '';
  while (value > 0) {
    value -= 1;
    letter = String.fromCharCode(65 + (value % 26)) + letter;
    value = Math.floor(value / 26);
  }
  return letter;
}

async function nextLetter() {
  const counter = await Counter.findOneAndUpdate(
    { _id: 'flightLetter' },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  return letterFor(counter.seq);
}

async function emitFlightSnapshot(io, slug, eventName, flight) {
  const current = await loadCorridor(slug);
  if (!current) return;
  io.to(slug).emit(eventName, {
    slug,
    flight: toClientFlight(flight, slug),
    flights: current.annotated,
  });
}

async function addActivity(io, corridor, text) {
  const entry = await ActivityEntry.create({ corridor: corridor._id, text });
  const activity = { _id: String(entry._id), text: entry.text, createdAt: entry.createdAt };
  io.to(corridor.slug).emit('activity:new', { slug: corridor.slug, activity });
  return activity;
}

async function notifyScheduleChange(io, flight, affectedFlights, actorId, title, message) {
  const recipientIds = new Set((affectedFlights || []).map((item) => String(item.owner || '')).filter(Boolean));
  if (flight.organization) {
    const teammates = await User.find({
      organization: flight.organization,
      isActive: true,
      _id: { $ne: actorId },
    }).select('_id');
    teammates.forEach((member) => recipientIds.add(String(member._id)));
  }
  recipientIds.delete(String(actorId));
  await Promise.all([...recipientIds].map((recipientId) => notifyUser(io, recipientId, {
    type: 'schedule', title, message, href: '/',
  })));
}

function proposalSummary(proposal, userId) {
  const incoming = String(proposal.recipientFlight.owner || '') === String(userId);
  return {
    id: String(proposal._id),
    status: proposal.status,
    direction: incoming ? 'incoming' : 'outgoing',
    proposerName: proposal.proposer.name,
    proposerFlight: {
      id: proposal.proposerFlight.letter,
      from: proposal.proposerFlight.from,
      to: proposal.proposerFlight.to,
    },
    recipientFlight: {
      id: proposal.recipientFlight.letter,
      from: proposal.recipientFlight.from,
      to: proposal.recipientFlight.to,
    },
    corridor: proposal.corridor.slug,
    corridorLabel: proposal.corridor.label,
    proposedBand: proposal.proposedBand,
    proposedStartMin: proposal.proposedStartMin,
    proposedEndMin: proposal.proposedEndMin,
    createdAt: proposal.createdAt,
    respondedAt: proposal.respondedAt,
  };
}

function proposalPopulate(query) {
  return query
    .populate('proposer', 'name')
    .populate('corridor', 'slug label')
    .populate('proposerFlight', 'letter from to owner')
    .populate('recipientFlight', 'letter from to owner');
}

function notifyProposal(io, proposal, eventName) {
  const proposerId = proposal.proposer._id || proposal.proposer;
  const target = proposal.recipientFlight.owner;
  io.to('user:' + String(proposerId)).emit(eventName, { proposalId: String(proposal._id) });
  if (target) io.to('user:' + String(target._id || target)).emit(eventName, { proposalId: String(proposal._id) });
}

function invalidId(id) {
  return !mongoose.Types.ObjectId.isValid(id);
}

function canManage(flight, userId) {
  const user = typeof userId === 'object' ? userId : null;
  const id = user ? user._id : userId;
  if (flight.isDemo) return Boolean(user && ['owner', 'admin', 'dispatcher', 'pilot'].includes(user.role));
  if (String(flight.owner || '') === String(id)) return Boolean(user && user.role !== 'viewer');
  return Boolean(user && ['owner', 'admin', 'dispatcher'].includes(user.role)
    && flight.organization && String(flight.organization) === String(user.organization));
}

router.get('/me/flights', requireAuth, async (req, res, next) => {
  try {
    const ownedFlights = await FlightPlan.find({ owner: req.session.userId })
      .populate('corridor', 'slug label')
      .sort({ startMin: 1, createdAt: -1 });
    const corridorIds = [...new Set(ownedFlights.map((flight) => String(flight.corridor._id)))];
    const snapshots = await Promise.all(corridorIds.map(async (corridorId) => {
      const corridor = ownedFlights.find((flight) => String(flight.corridor._id) === corridorId).corridor;
      const flights = await FlightPlan.find({ corridor: corridorId })
        .populate('aircraft', 'name registration enduranceMin')
        .populate('internalApprovalReviewedBy', 'name')
        .populate('authorityRecordedBy', 'name');
      return { slug: corridor.slug, label: corridor.label, annotated: annotateFlights(flights, corridor.slug) };
    }));
    const byId = new Map(snapshots.flatMap((snapshot) => snapshot.annotated.map((flight) => [flight._id, snapshot])));
    res.json(ownedFlights.map((flight) => {
      const snapshot = byId.get(String(flight._id));
      return {
        ...snapshot.annotated.find((item) => item._id === String(flight._id)),
        corridorLabel: snapshot.label,
      };
    }));
  } catch (error) {
    next(error);
  }
});

router.get('/me/proposals', requireAuth, async (req, res, next) => {
  try {
    const myFlights = await FlightPlan.find({ owner: req.session.userId }).select('_id');
    const ids = myFlights.map((flight) => flight._id);
    const proposals = await proposalPopulate(ConflictProposal.find({
      $or: [{ proposer: req.session.userId }, { recipientFlight: { $in: ids } }],
    }).sort({ createdAt: -1 }));
    res.json(proposals.filter((proposal) => proposal.proposerFlight && proposal.recipientFlight)
      .map((proposal) => proposalSummary(proposal, req.session.userId)));
  } catch (error) {
    next(error);
  }
});

router.post('/corridors/:slug/flights', requireAuth, requireOrganizationRole('owner', 'admin', 'dispatcher', 'pilot'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const error = validateFlight(body);
    if (error) return res.status(400).json({ error });
    const corridor = await Corridor.findOne({ slug: req.params.slug });
    if (!corridor) return res.status(404).json({ error: 'Corridor not found.' });
    if (body.clientRequestId) {
      const existing = await FlightPlan.findOne({ owner: req.session.userId, corridor: corridor._id, clientRequestId: body.clientRequestId });
      if (existing) {
        const current = await loadCorridor(corridor.slug);
        return res.status(200).json({ flight: current.annotated.find((item) => item._id === String(existing._id)) });
      }
    }
    let aircraft = null;
    if (body.aircraftId) {
      aircraft = await Aircraft.findOne({ _id: body.aircraftId, owner: req.session.userId, isArchived: false });
      if (!aircraft) return res.status(400).json({ error: 'Select an aircraft in your active fleet.' });
    }

    const flight = await FlightPlan.create({
      corridor: corridor._id,
      owner: req.session.userId,
      organization: req.user.organization,
      clientRequestId: body.clientRequestId,
      aircraft: aircraft ? aircraft._id : null,
      letter: await nextLetter(),
      operator: body.operator.trim(),
      ncaaId: (body.ncaaId || '').trim(),
      from: body.from.trim(),
      to: body.to.trim(),
      payload: body.payload,
      band: body.band,
      flightDate: body.flightDate,
      waypoints: body.waypoints,
      payloadDetails: body.payloadDetails || '',
      batteryStartPercent: body.batteryStartPercent ?? null,
      batteryReservePercent: body.batteryReservePercent ?? null,
      contingencyPlan: body.contingencyPlan || '',
      startMin: body.startMin,
      endMin: body.endMin,
    });
    const flights = await FlightPlan.find({ corridor: corridor._id });
    const conflicts = findConflicts(flight, flights, flight._id);
    const hasConflict = conflicts.length > 0;
    await addActivity(
      req.app.get('io'),
      corridor,
      'Route ' + flight.letter + ' submitted in ' + corridor.label + (hasConflict ? ' — conflict flagged.' : ' — clear.'),
    );
    await emitFlightSnapshot(req.app.get('io'), corridor.slug, 'flight:created', flight);
    await notifyScheduleChange(
      req.app.get('io'), flight, conflicts, req.user._id,
      hasConflict ? 'Flight plan conflict detected' : 'Organization flight plan submitted',
      hasConflict
        ? 'Route ' + flight.letter + ' in ' + corridor.label + ' conflicts with one of your plans. Review the corridor schedule.'
        : 'Route ' + flight.letter + ' was added to ' + corridor.label + ' on ' + flight.flightDate + '.',
    );
    const current = await loadCorridor(corridor.slug);
    const annotated = current.annotated.find((item) => item._id === String(flight._id));
    res.status(201).json({ flight: annotated });
  } catch (error) {
    if (error.code === 11000 && req.body?.clientRequestId) {
      const corridor = await Corridor.findOne({ slug: req.params.slug }).select('_id');
      const existing = await FlightPlan.findOne({
        owner: req.session.userId, corridor: corridor && corridor._id, clientRequestId: req.body.clientRequestId,
      });
      if (existing) {
        const current = await loadCorridor(req.params.slug);
        return res.status(200).json({ flight: current.annotated.find((item) => item._id === String(existing._id)) });
      }
    }
    next(error);
  }
});

router.patch('/flights/:id/internal-approval', requireAuth, async (req, res, next) => {
  try {
    if (!canReviewFlightPlans(req.user)) return res.status(403).json({ error: 'Only an owner, admin, or dispatcher can review flight plans.' });
    if (invalidId(req.params.id)) return res.status(400).json({ error: 'Invalid flight plan ID.' });
    const body = req.body || {};
    const error = validateInternalApproval(body);
    if (error) return res.status(400).json({ error });

    const flight = await FlightPlan.findOne({ _id: req.params.id, organization: req.user.organization });
    if (!flight) return res.status(404).json({ error: 'Flight plan not found in your organization.' });
    if (String(flight.owner) === String(req.user._id)) {
      return res.status(403).json({ error: 'A team member cannot approve their own flight plan.' });
    }

    flight.internalApprovalStatus = body.status;
    flight.internalApprovalReviewedBy = req.user._id;
    flight.internalApprovalReviewedAt = new Date();
    flight.internalApprovalNotes = typeof body.notes === 'string' ? body.notes.trim() : '';
    await flight.save();

    const corridor = await Corridor.findById(flight.corridor);
    const message = 'Route ' + flight.letter + ' received internal team status: ' + body.status + '.';
    await addActivity(req.app.get('io'), corridor, message);
    await emitFlightSnapshot(req.app.get('io'), corridor.slug, 'flight:updated', flight);
    if (flight.owner) await notifyUser(req.app.get('io'), flight.owner, {
      type: 'schedule', title: 'Team flight-plan review updated', message, href: '/',
    });
    res.json({ ok: true, flight: toClientFlight(flight, corridor.slug) });
  } catch (error) {
    next(error);
  }
});

router.get('/flights/:id/review-record', requireAuth, async (req, res, next) => {
  try {
    if (invalidId(req.params.id)) return res.status(400).json({ error: 'Invalid flight plan ID.' });
    const flight = await FlightPlan.findById(req.params.id).select(
      'organization owner internalApprovalNotes authorityNotes',
    );
    if (!flight) return res.status(404).json({ error: 'Flight plan not found.' });

    const canReviewTeam = canReviewFlightPlans(req.user)
      && String(flight.organization || '') === String(req.user.organization || '')
      && String(flight.owner || '') !== String(req.user._id);
    const canRecordAuthority = isFlightAuthorityReviewer(req.user);
    if (!canReviewTeam && !canRecordAuthority) {
      return res.status(403).json({ error: 'You are not allowed to view review notes for this flight plan.' });
    }

    res.json({
      internalApprovalNotes: canReviewTeam ? flight.internalApprovalNotes : undefined,
      authorityNotes: canRecordAuthority ? flight.authorityNotes : undefined,
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/flights/:id/authority-clearance', requireAuth, async (req, res, next) => {
  try {
    if (!isFlightAuthorityReviewer(req.user)) {
      return res.status(403).json({ error: 'Only configured aviation-authority reviewers can record authority decisions.' });
    }
    if (invalidId(req.params.id)) return res.status(400).json({ error: 'Invalid flight plan ID.' });
    const body = req.body || {};
    const flight = await FlightPlan.findById(req.params.id);
    if (!flight) return res.status(404).json({ error: 'Flight plan not found.' });
    const error = validateAuthorityRecord(body, flight.flightDate);
    if (error) return res.status(400).json({ error });

    flight.authorityClearanceStatus = body.status;
    flight.authorityName = body.status === 'not-requested' ? '' : body.authorityName.trim();
    flight.authorityReference = body.status === 'not-requested' ? '' : (body.authorityReference || '').trim();
    flight.authorityValidUntil = body.status !== 'not-requested' && body.validUntil ? new Date(body.validUntil) : null;
    flight.authorityNotes = body.status === 'not-requested' ? '' : (typeof body.notes === 'string' ? body.notes.trim() : '');
    flight.authorityRecordedBy = req.user._id;
    flight.authorityRecordedAt = new Date();
    await flight.save();

    const corridor = await Corridor.findById(flight.corridor);
    const message = 'Route ' + flight.letter + ' authority decision recorded: ' + body.status
      + (flight.authorityName ? ' by ' + flight.authorityName : '')
      + (flight.authorityReference ? ' · reference ' + flight.authorityReference : '') + '.';
    await addActivity(req.app.get('io'), corridor, message);
    await emitFlightSnapshot(req.app.get('io'), corridor.slug, 'flight:updated', flight);
    if (flight.owner) await notifyUser(req.app.get('io'), flight.owner, {
      type: 'schedule', title: 'Authority clearance record updated', message, href: '/',
    });
    res.json({ ok: true, flight: toClientFlight(flight, corridor.slug) });
  } catch (error) {
    next(error);
  }
});

router.post('/flights/:id/proposals', requireAuth, requireOrganizationRole('owner', 'admin', 'dispatcher', 'pilot'), async (req, res, next) => {
  try {
    if (invalidId(req.params.id) || !mongoose.Types.ObjectId.isValid(req.body?.conflictFlightId)) {
      return res.status(400).json({ error: 'A valid conflicting flight is required.' });
    }
    const flight = await FlightPlan.findById(req.params.id);
    const otherFlight = await FlightPlan.findById(req.body.conflictFlightId);
    if (!flight || !otherFlight) return res.status(404).json({ error: 'Flight plan not found.' });
    if (!canManage(flight, req.user)) {
      return res.status(403).json({ error: 'Your organization role cannot propose changes to this flight plan.' });
    }
    if (String(flight.corridor) !== String(otherFlight.corridor)
        || String(otherFlight.owner || '') === String(req.session.userId) || !otherFlight.owner
        || (flight.organization && String(flight.organization) === String(otherFlight.organization))) {
      return res.status(400).json({ error: 'Choose a conflicting plan owned by another operator.' });
    }

    const corridor = await Corridor.findById(flight.corridor);
    const flights = await FlightPlan.find({ corridor: corridor._id });
    if (findConflicts(flight, [otherFlight], flight._id).length === 0) {
      return res.status(409).json({ error: 'Those plans no longer conflict.' });
    }
    const duplicate = await ConflictProposal.findOne({
      proposerFlight: flight._id,
      recipientFlight: otherFlight._id,
      status: 'pending',
    });
    if (duplicate) return res.status(409).json({ error: 'A proposal is already pending for these plans.' });

    const schedule = scheduleFromFix(flight, suggestFix(flight, flights, flight._id));
    const proposal = await ConflictProposal.create({
      corridor: corridor._id,
      proposer: req.session.userId,
      proposerFlight: flight._id,
      recipientFlight: otherFlight._id,
      proposedBand: schedule.band,
      proposedStartMin: schedule.startMin,
      proposedEndMin: schedule.endMin,
    });
    await addActivity(req.app.get('io'), corridor,
      'Route ' + flight.letter + ' proposed a schedule change to resolve a conflict with Route ' + otherFlight.letter + '.');
    const populated = await proposalPopulate(ConflictProposal.findById(proposal._id));
    notifyProposal(req.app.get('io'), populated, 'proposal:new');
    await notifyUser(req.app.get('io'), otherFlight.owner, {
      type: 'proposal', title: 'Schedule proposal received',
      message: 'Route ' + flight.letter + ' proposed a change to resolve a conflict with your Route ' + otherFlight.letter + ' in ' + corridor.label + '.',
      href: '/',
    });
    res.status(201).json(proposalSummary(populated, req.session.userId));
  } catch (error) {
    next(error);
  }
});

router.post('/proposals/:id/respond', requireAuth, requireOrganizationRole('owner', 'admin', 'dispatcher', 'pilot'), async (req, res, next) => {
  try {
    if (invalidId(req.params.id)) return res.status(400).json({ error: 'Invalid proposal ID.' });
    const decision = req.body?.decision;
    if (!['accept', 'decline'].includes(decision)) return res.status(400).json({ error: 'Choose accept or decline.' });
    const proposal = await ConflictProposal.findById(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found.' });
    const recipientFlight = await FlightPlan.findById(proposal.recipientFlight);
    if (!recipientFlight || String(recipientFlight.owner || '') !== String(req.session.userId)) {
      return res.status(403).json({ error: 'Only the other plan owner can respond to this proposal.' });
    }
    if (proposal.status !== 'pending') return res.status(409).json({ error: 'This proposal is no longer pending.' });

    const proposerFlight = await FlightPlan.findById(proposal.proposerFlight);
    const corridor = await Corridor.findById(proposal.corridor);
    if (!proposerFlight || !corridor) {
      proposal.status = 'stale';
      proposal.respondedAt = new Date();
      await proposal.save();
      if (proposerFlight.owner) await notifyUser(req.app.get('io'), proposerFlight.owner, {
        type: 'proposal', title: 'Schedule proposal is stale',
        message: 'A flight plan in your schedule proposal no longer exists.', href: '/',
      });
      notifyProposal(req.app.get('io'), proposal, 'proposal:updated');
      return res.status(409).json({ error: 'A flight plan in this proposal no longer exists.' });
    }

    if (decision === 'decline') {
      proposal.status = 'declined';
      proposal.respondedAt = new Date();
      await proposal.save();
      await addActivity(req.app.get('io'), corridor, 'A schedule proposal for Route ' + proposerFlight.letter + ' was declined.');
      await notifyUser(req.app.get('io'), proposerFlight.owner, {
        type: 'proposal', title: 'Schedule proposal declined',
        message: 'The proposal for Route ' + proposerFlight.letter + ' in ' + corridor.label + ' was declined.', href: '/',
      });
      const populated = await proposalPopulate(ConflictProposal.findById(proposal._id));
      notifyProposal(req.app.get('io'), populated, 'proposal:updated');
      return res.json(proposalSummary(populated, req.session.userId));
    }

    const flights = await FlightPlan.find({ corridor: corridor._id });
    const stillConflicts = findConflicts(proposerFlight, flights, proposerFlight._id).length > 0;
    const schedule = {
      band: proposal.proposedBand,
      startMin: proposal.proposedStartMin,
      endMin: proposal.proposedEndMin,
    };
    if (!stillConflicts || !proposalResolvesConflicts(proposerFlight, flights, schedule)) {
      proposal.status = 'stale';
      proposal.respondedAt = new Date();
      await proposal.save();
      if (proposerFlight.owner) await notifyUser(req.app.get('io'), proposerFlight.owner, {
        type: 'proposal', title: 'Schedule proposal needs an update',
        message: 'Corridor traffic changed before the proposal was accepted. Review your route and send a new proposal.', href: '/',
      });
      notifyProposal(req.app.get('io'), proposal, 'proposal:updated');
      return res.status(409).json({ error: 'Traffic changed; this proposal no longer resolves the current conflict.' });
    }

    proposerFlight.band = schedule.band;
    proposerFlight.startMin = schedule.startMin;
    proposerFlight.endMin = schedule.endMin;
    const previousDecisions = resetFlightDecisions(proposerFlight);
    await proposerFlight.save();
    proposal.status = 'accepted';
    proposal.respondedAt = new Date();
    await proposal.save();
    await addActivity(req.app.get('io'), corridor,
      'Route ' + proposerFlight.letter + ' schedule proposal accepted; conflict resolved. ' + decisionResetNote(previousDecisions));
    await notifyUser(req.app.get('io'), proposerFlight.owner, {
      type: 'proposal', title: 'Schedule proposal accepted',
      message: 'The proposal for Route ' + proposerFlight.letter + ' was accepted and the corridor schedule was updated.', href: '/',
    });
    await emitFlightSnapshot(req.app.get('io'), corridor.slug, 'flight:updated', proposerFlight);
    const populated = await proposalPopulate(ConflictProposal.findById(proposal._id));
    notifyProposal(req.app.get('io'), populated, 'proposal:updated');
    res.json(proposalSummary(populated, req.session.userId));
  } catch (error) {
    next(error);
  }
});

router.delete('/flights/:id', requireAuth, requireOrganizationRole('owner', 'admin', 'dispatcher', 'pilot'), async (req, res, next) => {
  try {
    if (invalidId(req.params.id)) return res.status(400).json({ error: 'Invalid flight ID.' });
    const flight = await FlightPlan.findById(req.params.id);
    if (!flight) return res.status(404).json({ error: 'Flight plan not found.' });
    if (!canManage(flight, req.user)) return res.status(403).json({ error: 'Your organization role cannot cancel this flight plan.' });
    const corridor = await Corridor.findById(flight.corridor);
    await flight.deleteOne();
    const activity = await addActivity(
      req.app.get('io'), corridor,
      'Route ' + flight.letter + ' cancelled in ' + corridor.label + '.',
    );
    await emitFlightSnapshot(req.app.get('io'), corridor.slug, 'flight:cancelled', flight);
    res.json({ ok: true, activity });
  } catch (error) {
    next(error);
  }
});

router.post('/flights/:id/feedback', requireAuth, async (req, res, next) => {
  try {
    if (invalidId(req.params.id)) return res.status(400).json({ error: 'Invalid flight ID.' });
    const error = validateFeedback(req.body || {});
      const flights = await FlightPlan.find({ corridor: corridor._id });
      const conflicts = findConflicts(flight, flights, flight._id);
      await notifyScheduleChange(req.app.get('io'), flight, conflicts, req.user._id,
        'Flight plan cancelled', 'Route ' + flight.letter + ' was cancelled in ' + corridor.label + '.');
    if (error) return res.status(400).json({ error });
    const flight = await FlightPlan.findById(req.params.id);
    if (!flight) return res.status(404).json({ error: 'Flight plan not found.' });
    if (String(flight.owner || '') !== String(req.session.userId)) return res.status(403).json({ error: 'Only the flight-plan owner can log its outcome.' });
    flight.actualStartMin = req.body.actualStartMin;
    flight.actualEndMin = req.body.actualEndMin;
    flight.disruption = req.body.disruption;
    flight.outcomeNotes = (req.body.outcomeNotes || '').trim();
    flight.feedbackAt = new Date();
    await flight.save();
    const corridor = await Corridor.findById(flight.corridor);
    await addActivity(req.app.get('io'), corridor, 'Route ' + flight.letter + ' post-flight outcome recorded.');
    await emitFlightSnapshot(req.app.get('io'), corridor.slug, 'flight:updated', flight);
    const current = await loadCorridor(corridor.slug);
    res.json({ flight: current.annotated.find((item) => item._id === String(flight._id)) });
  } catch (error) {
    next(error);
  }
});

router.post('/flights/:id/apply-fix', requireAuth, requireOrganizationRole('owner', 'admin', 'dispatcher', 'pilot'), async (req, res, next) => {
  try {
    if (invalidId(req.params.id)) return res.status(400).json({ error: 'Invalid flight ID.' });
    const flight = await FlightPlan.findById(req.params.id);
    if (!flight) return res.status(404).json({ error: 'Flight plan not found.' });
    if (!canManage(flight, req.user)) return res.status(403).json({ error: 'Your organization role cannot apply fixes to this flight plan.' });
    const corridor = await Corridor.findById(flight.corridor);
    const flights = await FlightPlan.find({ corridor: corridor._id });
    const conflicts = findConflicts(flight, flights, flight._id);
    if (conflicts.length === 0) return res.status(409).json({ error: 'This flight no longer has a conflict.' });

    const fix = suggestFix(flight, flights, flight._id);
    if (fix.type === 'band') {
      flight.band = fix.value;
    } else {
      const duration = flight.endMin - flight.startMin;
      flight.startMin = fix.value;
      flight.endMin = fix.value + duration;
    }
    const previousDecisions = resetFlightDecisions(flight);
    await flight.save();
    const activity = await addActivity(
      req.app.get('io'), corridor,
      'Route ' + flight.letter + ' fix applied — conflict resolved in ' + corridor.label + '. ' + decisionResetNote(previousDecisions),
    );
    await emitFlightSnapshot(req.app.get('io'), corridor.slug, 'flight:updated', flight);
    const current = await loadCorridor(corridor.slug);
    const updatedFlight = current.annotated.find((item) => item._id === String(flight._id));
    await notifyScheduleChange(req.app.get('io'), flight, conflicts, req.user._id,
      'Corridor schedule updated', 'Route ' + flight.letter + ' changed altitude or departure time in ' + corridor.label + '.');
        res.json({ flight: updatedFlight, activity, fix });
  } catch (error) {
    next(error);
  }
});

module.exports = {
  router, letterFor, validateFlight, validateFeedback, canManage,
  validateInternalApproval, validateAuthorityRecord, resetFlightDecisions, decisionResetNote,
};