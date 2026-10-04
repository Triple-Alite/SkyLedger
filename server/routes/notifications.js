const express = require('express');
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function toClientNotification(item) {
  return {
    id: String(item._id), type: item.type, title: item.title, message: item.message,
    href: item.href, readAt: item.readAt, emailStatus: item.emailStatus, createdAt: item.createdAt,
  };
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const notifications = await Notification.find({ recipient: req.user._id }).sort({ createdAt: -1 }).limit(50);
    res.json(notifications.map(toClientNotification));
  } catch (error) {
    next(error);
  }
});

router.patch('/read-all', requireAuth, async (req, res, next) => {
  try {
    await Notification.updateMany({ recipient: req.user._id, readAt: null }, { $set: { readAt: new Date() } });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/read', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid notification ID.' });
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.user._id },
      { $set: { readAt: new Date() } },
      { new: true },
    );
    if (!notification) return res.status(404).json({ error: 'Notification not found.' });
    res.json(toClientNotification(notification));
  } catch (error) {
    next(error);
  }
});

module.exports = { router, toClientNotification };