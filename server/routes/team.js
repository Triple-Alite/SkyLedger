const express = require('express');
const { createHash, randomBytes } = require('node:crypto');
const OrganizationInvite = require('../models/OrganizationInvite');
const User = require('../models/User');
const { requireAuth, requireOrganizationRole } = require('../middleware/auth');
const { sendEmail } = require('../lib/mailer');
const { notifyUser } = require('../lib/notifications');

const router = express.Router();
const INVITABLE_ROLES = new Set(['admin', 'dispatcher', 'pilot', 'viewer']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateInvitation(email, role, requesterRole) {
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return 'Enter a valid email address.';
  if (!INVITABLE_ROLES.has(role)) return 'Choose admin, dispatcher, pilot, or viewer.';
  if (requesterRole === 'admin' && role === 'admin') return 'Only an owner can invite another admin.';
  return null;
}

function invitationData(invite) {
  return {
    id: String(invite._id), email: invite.email, role: invite.role,
    status: invite.status, expiresAt: invite.expiresAt, createdAt: invite.createdAt,
  };
}

router.get('/', requireAuth, requireOrganizationRole('owner', 'admin'), async (req, res, next) => {
  try {
    const members = await User.find({ organization: req.user.organization }).sort({ createdAt: 1 }).select('name email role isActive createdAt');
    const invitations = await OrganizationInvite.find({ organization: req.user.organization, status: 'pending', expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
    res.json({
      members: members.map((member) => ({
        id: String(member._id), name: member.name, email: member.email,
        role: member.role, isActive: member.isActive, createdAt: member.createdAt,
      })),
      invitations: invitations.map(invitationData),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/invitations', requireAuth, requireOrganizationRole('owner', 'admin'), async (req, res, next) => {
  try {
    const email = typeof (req.body || {}).email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const role = req.body && req.body.role;
    const error = validateInvitation(email, role, req.user.role);
    if (error) return res.status(req.user.role === 'admin' && role === 'admin' ? 403 : 400).json({ error });

    const existing = await User.findOne({ email }).select('organization');
    if (existing) return res.status(409).json({ error: 'This email already has a SkyLedger account. Ask them to leave their current team before inviting them.' });
    await OrganizationInvite.updateMany(
      { organization: req.user.organization, email, status: 'pending', expiresAt: { $lte: new Date() } },
      { $set: { status: 'revoked' } },
    );
    const pending = await OrganizationInvite.findOne({ organization: req.user.organization, email, status: 'pending', expiresAt: { $gt: new Date() } });
    if (pending) return res.status(409).json({ error: 'A pending invitation already exists for this email.' });

    const rawToken = randomBytes(32).toString('hex');
    const invite = await OrganizationInvite.create({
      organization: req.user.organization,
      email,
      role,
      tokenHash: createHash('sha256').update(rawToken).digest('hex'),
      invitedBy: req.user._id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    const organizationName = req.user.organizationName;
    const baseUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    const invitationLink = baseUrl + '/?invite=' + encodeURIComponent(rawToken) + '&email=' + encodeURIComponent(email);
    const emailStatus = await sendEmail({
      to: email,
      subject: 'Invitation to join ' + organizationName + ' on SkyLedger',
      text: organizationName + ' invited you to join SkyLedger as ' + role + '.\n\nCreate your account here: ' + invitationLink + '\n\nThis invitation expires in 7 days.',
    });
    res.status(201).json({ invitation: invitationData(invite), emailStatus, invitationLink: emailStatus === 'sent' ? undefined : invitationLink });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'An active invitation already exists for this email.' });
    next(error);
  }
});

router.patch('/:memberId/role', requireAuth, requireOrganizationRole('owner', 'admin'), async (req, res, next) => {
  try {
    const member = await User.findOne({ _id: req.params.memberId, organization: req.user.organization });
    if (!member) return res.status(404).json({ error: 'Team member not found.' });
    if (String(member._id) === String(req.user._id) || member.role === 'owner') return res.status(403).json({ error: 'The organization owner role cannot be changed here.' });
    const role = req.body && req.body.role;
    if (!INVITABLE_ROLES.has(role)) return res.status(400).json({ error: 'Choose admin, dispatcher, pilot, or viewer.' });
    if (req.user.role === 'admin' && (member.role === 'admin' || role === 'admin')) return res.status(403).json({ error: 'Only an owner can manage admin roles.' });
    member.role = role;
    await member.save();
    await notifyUser(req.app.get('io'), member._id, {
      type: 'invite', title: 'Organization role updated',
      message: 'Your role in ' + req.user.organizationName + ' is now ' + member.role + '.', href: '/',
    });
    res.json({ id: String(member._id), role: member.role });
  } catch (error) {
    next(error);
  }
});

router.delete('/:memberId', requireAuth, requireOrganizationRole('owner', 'admin'), async (req, res, next) => {
  try {
    const member = await User.findOne({ _id: req.params.memberId, organization: req.user.organization });
    if (!member) return res.status(404).json({ error: 'Team member not found.' });
    if (String(member._id) === String(req.user._id) || member.role === 'owner') return res.status(403).json({ error: 'The organization owner cannot be removed.' });
    if (req.user.role === 'admin' && member.role === 'admin') return res.status(403).json({ error: 'Only an owner can remove an admin.' });
    member.isActive = false;
    await member.save();
    req.app.get('io').in('user:' + String(member._id)).disconnectSockets(true);
    await notifyUser(req.app.get('io'), member._id, {
      type: 'invite', title: 'Organization access removed',
      message: 'Your access to ' + req.user.organizationName + ' has been removed.', href: '/',
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.delete('/invitations/:inviteId', requireAuth, requireOrganizationRole('owner', 'admin'), async (req, res, next) => {
  try {
    const invite = await OrganizationInvite.findOne({ _id: req.params.inviteId, organization: req.user.organization, status: 'pending' });
    if (!invite) return res.status(404).json({ error: 'Pending invitation not found.' });
    invite.status = 'revoked';
    await invite.save();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = { router, INVITABLE_ROLES, validateInvitation };