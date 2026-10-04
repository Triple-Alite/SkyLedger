const express = require('express');
const bcrypt = require('bcryptjs');
const { createHash, randomBytes, randomInt } = require('node:crypto');
const User = require('../models/User');
const Organization = require('../models/Organization');
const OrganizationInvite = require('../models/OrganizationInvite');
const PasswordResetToken = require('../models/PasswordResetToken');
const EmailVerificationToken = require('../models/EmailVerificationToken');
const { canReviewFlightPlans, isAirspaceReviewer, isFlightAuthorityReviewer } = require('../middleware/auth');
const { notifyUser } = require('../lib/notifications');
const { sendEmail } = require('../lib/mailer');

const router = express.Router();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(user) {
  return {
    id: String(user._id),
    organizationName: user.organizationName || user.name,
    organizationId: user.organization ? String(user.organization._id || user.organization) : null,
    role: user.role || 'owner',
    canReviewFlightPlans: canReviewFlightPlans(user),
    canRecordAuthorityDecision: isFlightAuthorityReviewer(user),
    canReviewAirspace: isAirspaceReviewer(user),
    name: user.name,
    email: user.email,
    emailVerified: Boolean(user.emailVerified),
  };
}

async function issueVerificationEmail(user) {
  const code = String(randomInt(100000, 1000000));
  const tokenHash = createHash('sha256').update(String(user._id) + ':' + code).digest('hex');
  await EmailVerificationToken.updateMany({ user: user._id, usedAt: null }, { $set: { usedAt: new Date() } });
  await EmailVerificationToken.create({
    user: user._id,
    tokenHash,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });

  const emailStatus = await sendEmail({
    to: user.email,
    subject: 'Your SkyLedger verification code',
    text: 'Hi ' + user.name + ',\n\nYour SkyLedger email verification code is ' + code + '.\n\nEnter this code in SkyLedger within 15 minutes. You can request another code if it expires.',
  });

  return { emailStatus };
}

function validateVerificationCode(code) {
  return typeof code === 'string' && /^\d{6}$/.test(code) ? null : 'Enter the six-digit verification code.';
}

function validatePassword(password) {
  if (Buffer.byteLength(password, 'utf8') < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    return 'Password must be between 8 and 72 bytes.';
  }
  return null;
}

function validateSignup(organizationName, name, email, password, isInvite = false) {
  if (!isInvite && (organizationName.length < 2 || organizationName.length > 100)) return 'Organization name must be 2 to 100 characters.';
  if (name.length < 2 || name.length > 80) return 'Name must be 2 to 80 characters.';
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return 'Enter a valid email address.';
  return validatePassword(password);
}

function establishSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.userId = String(userId);
      req.session.save((saveError) => saveError ? reject(saveError) : resolve());
    });
  });
}

router.get('/me', async (req, res, next) => {
  try {
    if (!req.session.userId) return res.json({ user: null });
    const user = await User.findById(req.session.userId).select('organization organizationName role name email emailVerified isActive');
    if (!user || !user.isActive) {
      req.session.destroy(() => {});
      return res.json({ user: null });
    }
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

router.get('/invitations/:token', async (req, res, next) => {
  try {
    if (req.params.token.length !== 64) return res.status(400).json({ error: 'Invalid invitation.' });
    const tokenHash = createHash('sha256').update(req.params.token).digest('hex');
    const invite = await OrganizationInvite.findOne({ tokenHash, status: 'pending', expiresAt: { $gt: new Date() } })
      .populate('organization', 'name');
    if (!invite) return res.status(404).json({ error: 'This team invitation is invalid or expired.' });
    res.json({ email: invite.email, organizationName: invite.organization.name, role: invite.role, expiresAt: invite.expiresAt });
  } catch (error) {
    next(error);
  }
});

router.post('/signup', async (req, res, next) => {
  let createdOrganization = null;
  try {
    const body = req.body || {};
    const organizationName = typeof body.organizationName === 'string' ? body.organizationName.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const inviteToken = typeof body.inviteToken === 'string' ? body.inviteToken : '';
    const error = validateSignup(organizationName, name, email, password, Boolean(inviteToken));
    if (error) return res.status(400).json({ error });

    let invite = null;
    if (inviteToken) {
      const tokenHash = createHash('sha256').update(inviteToken).digest('hex');
      invite = await OrganizationInvite.findOne({
        tokenHash, email, status: 'pending', expiresAt: { $gt: new Date() },
      }).populate('organization');
      if (!invite) return res.status(400).json({ error: 'This team invitation is invalid or expired.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    let organization = invite && invite.organization;
    if (!organization) {
      organization = await Organization.create({ name: organizationName });
      createdOrganization = organization;
    }
    const user = await User.create({
      organization: organization._id,
      role: invite ? invite.role : 'owner',
      organizationName: invite ? organization.name : organizationName,
      name, email, passwordHash,
      emailVerified: false,
    });
    if (!invite) {
      organization.owner = user._id;
      await organization.save();
    } else {
      invite.status = 'accepted';
      await invite.save();
      await notifyUser(req.app.get('io'), invite.invitedBy, {
        type: 'invite', title: 'Team invitation accepted',
        message: user.name + ' joined ' + organization.name + ' as ' + user.role + '.', href: '/',
      });
    }
    const verification = await issueVerificationEmail(user);
    res.status(201).json({
      user: publicUser(user),
      requiresVerification: true,
      emailStatus: verification.emailStatus,
      message: 'Enter the six-digit code sent to your email before signing in.',
    });
  } catch (error) {
    if (createdOrganization && error.code === 11000) await Organization.deleteOne({ _id: createdOrganization._id });
    if (error.code === 11000) return res.status(409).json({ error: 'An account with this email already exists.' });
    next(error);
  }
});

router.post('/verify-email', async (req, res, next) => {
  try {
    const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    let verificationToken;
    if (rawToken) {
      verificationToken = await EmailVerificationToken.findOne({
        tokenHash: createHash('sha256').update(rawToken).digest('hex'),
        usedAt: null,
        expiresAt: { $gt: new Date() },
      }).populate('user');
    } else {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
      const codeError = validateVerificationCode(code);
      if (!EMAIL_PATTERN.test(email)) return res.status(400).json({ error: 'Enter the email used to register.' });
      if (codeError) return res.status(400).json({ error: codeError });

      const user = await User.findOne({ email, isActive: true })
        .select('organization organizationName role name email emailVerified isActive');
      if (!user || user.emailVerified) return res.status(400).json({ error: 'This verification code is invalid or expired.' });

      verificationToken = await EmailVerificationToken.findOne({
        user: user._id,
        usedAt: null,
        expiresAt: { $gt: new Date() },
        attempts: { $lt: 5 },
      }).sort({ createdAt: -1 });
      const tokenHash = createHash('sha256').update(String(user._id) + ':' + code).digest('hex');
      if (!verificationToken || verificationToken.tokenHash !== tokenHash) {
        if (verificationToken) {
          verificationToken.attempts += 1;
          if (verificationToken.attempts >= 5) verificationToken.usedAt = new Date();
          await verificationToken.save();
        }
        return res.status(400).json({ error: 'This verification code is invalid or expired. Request a new code and try again.' });
      }
      verificationToken.user = user;
    }

    if (!verificationToken || !verificationToken.user || !verificationToken.user.isActive) {
      return res.status(400).json({ error: 'This verification code or link is invalid or expired.' });
    }

    verificationToken.user.emailVerified = true;
    verificationToken.user.emailVerifiedAt = new Date();
    await verificationToken.user.save();
    verificationToken.usedAt = new Date();
    await verificationToken.save();
    await EmailVerificationToken.deleteMany({ user: verificationToken.user._id, _id: { $ne: verificationToken._id } });

    res.json({ ok: true, user: publicUser(verificationToken.user) });
  } catch (error) {
    next(error);
  }
});

router.post('/resend-verification', async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!EMAIL_PATTERN.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

    const user = await User.findOne({ email }).select('_id name email emailVerified isActive');
    if (!user || !user.isActive) return res.json({ ok: true });
    if (user.emailVerified) return res.json({ ok: true });

    const activeToken = await EmailVerificationToken.findOne({ user: user._id, usedAt: null }).sort({ createdAt: -1 });
    if (activeToken && Date.now() - activeToken.createdAt.getTime() < 60 * 1000) return res.json({ ok: true });

    await issueVerificationEmail(user);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const body = req.body || {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = await User.findOne({ email }).select('+passwordHash organization organizationName role name email emailVerified isActive');
    if (!user || !user.isActive || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    if (!user.emailVerified) {
      return res.status(403).json({ error: 'Please verify your email before signing in.' });
    }
    await establishSession(req, user._id);
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

router.get('/validate-verification-token/:token', async (req, res, next) => {
  try {
    const token = typeof req.params.token === 'string' ? req.params.token.trim() : '';
    if (!token) return res.status(400).json({ error: 'Invalid verification token.' });
    const verificationToken = await EmailVerificationToken.findOne({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      usedAt: null,
      expiresAt: { $gt: new Date() },
    }).populate('user');
    res.json({ ok: Boolean(verificationToken && verificationToken.user && verificationToken.user.isActive) });
  } catch (error) {
    next(error);
  }
});

router.post('/forgot-password', async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!EMAIL_PATTERN.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    const user = await User.findOne({ email }).select('_id name organizationName email isActive');
    if (!user || !user.isActive) return res.json({ ok: true });

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await PasswordResetToken.updateMany({ user: user._id, usedAt: null }, { $set: { usedAt: new Date() } });
    await PasswordResetToken.create({
      user: user._id,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const resetUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '') + '/?resetToken=' + encodeURIComponent(rawToken);
    await sendEmail({
      to: user.email,
      subject: 'Reset your SkyLedger password',
      text: 'Hi ' + user.name + ',\n\nUse this link to reset your SkyLedger password: ' + resetUrl + '\n\nThis link expires in 1 hour.',
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const body = req.body || {};
    const rawToken = typeof body.token === 'string' ? body.token.trim() : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    const tokenError = rawToken.length ? null : 'Invalid reset token.';
    if (tokenError) return res.status(400).json({ error: tokenError });

    const passwordError = validatePassword(newPassword);
    if (passwordError) return res.status(400).json({ error: passwordError });

    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const resetToken = await PasswordResetToken.findOne({
      tokenHash,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    }).populate('user');
    if (!resetToken || !resetToken.user || !resetToken.user.isActive) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    resetToken.user.passwordHash = passwordHash;
    await resetToken.user.save();
    resetToken.usedAt = new Date();
    await resetToken.save();
    await PasswordResetToken.deleteMany({ user: resetToken.user._id, _id: { $ne: resetToken._id } });

    await establishSession(req, resetToken.user._id);
    res.json({ ok: true, user: publicUser(resetToken.user) });
  } catch (error) {
    next(error);
  }
});

router.get('/validate-reset-token/:token', async (req, res, next) => {
  try {
    const token = typeof req.params.token === 'string' ? req.params.token.trim() : '';
    if (!token) return res.status(400).json({ error: 'Invalid reset token.' });
    const resetToken = await PasswordResetToken.findOne({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      usedAt: null,
      expiresAt: { $gt: new Date() },
    }).populate('user');
    res.json({ ok: Boolean(resetToken && resetToken.user && resetToken.user.isActive) });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', (req, res, next) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('skyledger.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.json({ ok: true });
  });
});

module.exports = { router, publicUser, validatePassword, validateSignup, validateVerificationCode };