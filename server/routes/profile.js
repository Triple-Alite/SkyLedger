const express = require('express');
const bcrypt = require('bcryptjs');
const { randomBytes } = require('node:crypto');
const Aircraft = require('../models/Aircraft');
const Organization = require('../models/Organization');
const OrganizationInvite = require('../models/OrganizationInvite');
const EmailVerificationToken = require('../models/EmailVerificationToken');
const Notification = require('../models/Notification');
const PasswordResetToken = require('../models/PasswordResetToken');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function validateProfileUpdate(body, role) {
  const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
  const hasOrganizationName = Object.prototype.hasOwnProperty.call(body, 'organizationName');
  if (!hasName && !hasOrganizationName) return 'Update at least one profile setting.';
  if (hasName && (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 80)) {
    return 'Pilot name must be 2 to 80 characters.';
  }
  if (hasOrganizationName && !['owner', 'admin'].includes(role)) {
    return 'Only an owner or admin can change the organization name.';
  }
  if (hasOrganizationName && (typeof body.organizationName !== 'string'
      || body.organizationName.trim().length < 2 || body.organizationName.trim().length > 100)) {
    return 'Organization name must be 2 to 100 characters.';
  }
  return null;
}

function validateAccountDeletion(body) {
  if (typeof body.password !== 'string' || !body.password) return 'Enter your current password to delete your account.';
  if (body.transferToUserId != null
      && (typeof body.transferToUserId !== 'string' || body.transferToUserId.length > 100)) {
    return 'Choose a valid successor account.';
  }
  return null;
}

async function buildProfile(userId) {
  const user = await User.findById(userId)
    .select('organization organizationName role name email emailVerified emailVerifiedAt createdAt')
    .populate({
      path: 'organization',
      select: 'name owner createdAt',
      populate: { path: 'owner', select: 'name email' },
    });
  if (!user) return null;

  const members = user.organization
    ? await User.find({ organization: user.organization._id, isActive: true })
      .select('name role createdAt')
      .sort({ createdAt: 1 })
    : [user];
  const owner = user.organization && user.organization.owner;

  return {
    user: {
      id: String(user._id), name: user.name, email: user.email,
      emailVerified: Boolean(user.emailVerified), emailVerifiedAt: user.emailVerifiedAt,
      role: user.role || 'owner', createdAt: user.createdAt,
    },
    organization: {
      id: user.organization ? String(user.organization._id) : null,
      name: user.organization ? user.organization.name : (user.organizationName || user.name),
      createdAt: user.organization ? user.organization.createdAt : null,
      owner: owner ? { name: owner.name, email: owner.email } : { name: user.name, email: user.email },
      memberCount: members.length,
      members: members.map((member) => ({
        id: String(member._id), name: member.name, role: member.role || 'owner', createdAt: member.createdAt,
      })),
    },
  };
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const profile = await buildProfile(req.user._id);
    if (!profile) return res.status(404).json({ error: 'Profile not found.' });
    res.json(profile);
  } catch (error) {
    next(error);
  }
});

router.patch('/', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const error = validateProfileUpdate(body, req.user.role);
    if (error) return res.status(400).json({ error });

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'Profile not found.' });
    if (Object.prototype.hasOwnProperty.call(body, 'name')) user.name = body.name.trim();

    if (Object.prototype.hasOwnProperty.call(body, 'organizationName')) {
      const organizationName = body.organizationName.trim();
      if (user.organization) {
        const organization = await Organization.findById(user.organization);
        if (!organization) return res.status(404).json({ error: 'Organization not found.' });
        organization.name = organizationName;
        await organization.save();
        await User.updateMany({ organization: organization._id }, { $set: { organizationName } });
        user.organizationName = organizationName;
      } else {
        user.organizationName = organizationName;
      }
    }

    await user.save();
    const profile = await buildProfile(user._id);
    res.json(profile);
  } catch (error) {
    next(error);
  }
});

router.delete('/', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const error = validateAccountDeletion(body);
    if (error) return res.status(400).json({ error });

    const user = await User.findById(req.user._id).select('+passwordHash organization organizationName role email isActive');
    if (!user || !user.isActive) return res.status(404).json({ error: 'Account not found.' });
    if (!(await bcrypt.compare(body.password, user.passwordHash))) {
      return res.status(403).json({ error: 'Current password is incorrect.' });
    }

    let organization = user.organization ? await Organization.findById(user.organization) : null;
    let successor = null;
    const isOrganizationOwner = Boolean(organization
      && (user.role === 'owner' || String(organization.owner || '') === String(user._id)));

    if (isOrganizationOwner && organization) {
      const activeMembers = await User.find({
        organization: organization._id,
        isActive: true,
        _id: { $ne: user._id },
      }).select('_id');

      if (activeMembers.length) {
        if (!body.transferToUserId) {
          return res.status(400).json({ error: 'Choose an active team member to own the organization before deleting this account.' });
        }
        successor = await User.findOne({
          _id: body.transferToUserId,
          organization: organization._id,
          isActive: true,
          _id: { $ne: user._id },
        });
        if (!successor) return res.status(400).json({ error: 'The selected successor is not an active member of this organization.' });
        successor.role = 'owner';
        await successor.save();
        organization.owner = successor._id;
      } else {
        organization.owner = null;
      }
      await organization.save();
    } else if (body.transferToUserId) {
      return res.status(400).json({ error: 'Only an organization owner can transfer ownership during account deletion.' });
    }

    const userId = String(user._id);
    if (user.organization) {
      await OrganizationInvite.updateMany(
        { invitedBy: user._id, status: 'pending' },
        { $set: { status: 'revoked' } },
      );
    }
    await Promise.all([
      Aircraft.updateMany({ owner: user._id, isArchived: false }, { $set: { isArchived: true } }),
      EmailVerificationToken.deleteMany({ user: user._id }),
      PasswordResetToken.deleteMany({ user: user._id }),
      Notification.deleteMany({ recipient: user._id }),
    ]);

    user.name = 'Deleted account';
    user.email = 'deleted+' + userId + '@deleted.invalid';
    user.passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
    user.emailVerified = false;
    user.emailVerifiedAt = null;
    user.isActive = false;
    user.role = 'viewer';
    await user.save();

    req.app.get('io').in('user:' + userId).disconnectSockets(true);
    req.session.destroy((sessionError) => {
      if (sessionError) return next(sessionError);
      res.clearCookie('skyledger.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
      res.json({ ok: true, organizationTransferredTo: successor ? String(successor._id) : null });
    });
  } catch (error) {
    next(error);
  }
});

module.exports = { router, buildProfile, validateProfileUpdate, validateAccountDeletion };