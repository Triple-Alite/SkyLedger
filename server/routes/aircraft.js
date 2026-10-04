const express = require('express');
const mongoose = require('mongoose');
const Aircraft = require('../models/Aircraft');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function validateAircraft(body) {
  if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 80) {
    return 'Aircraft name must be 2 to 80 characters.';
  }
  if (!Number.isInteger(body.enduranceMin) || body.enduranceMin < 1 || body.enduranceMin > 1440) {
    return 'Maximum endurance must be between 1 and 1440 minutes.';
  }
  for (const field of ['manufacturer', 'model']) {
    if (body[field] != null && (typeof body[field] !== 'string' || body[field].length > 80)) return field + ' must be text with at most 80 characters.';
  }
  if (body.registration != null && (typeof body.registration !== 'string' || body.registration.length > 40)) return 'registration must be text with at most 40 characters.';
  return null;
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const aircraft = await Aircraft.find({ owner: req.session.userId, isArchived: false }).sort({ name: 1 });
    res.json(aircraft.map((item) => ({
      id: String(item._id), name: item.name, manufacturer: item.manufacturer,
      model: item.model, registration: item.registration, enduranceMin: item.enduranceMin,
    })));
  } catch (error) {
    next(error);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const error = validateAircraft(body);
    if (error) return res.status(400).json({ error });
    const aircraft = await Aircraft.create({
      owner: req.session.userId,
      name: body.name.trim(),
      manufacturer: (body.manufacturer || '').trim(),
      model: (body.model || '').trim(),
      registration: (body.registration || '').trim(),
      enduranceMin: body.enduranceMin,
    });
    res.status(201).json({
      id: String(aircraft._id), name: aircraft.name, manufacturer: aircraft.manufacturer,
      model: aircraft.model, registration: aircraft.registration, enduranceMin: aircraft.enduranceMin,
    });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'That registration is already in your fleet.' });
    next(error);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid aircraft ID.' });
    const aircraft = await Aircraft.findOneAndUpdate(
      { _id: req.params.id, owner: req.session.userId, isArchived: false },
      { $set: { isArchived: true } },
      { new: true },
    );
    if (!aircraft) return res.status(404).json({ error: 'Aircraft not found.' });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = { router, validateAircraft };