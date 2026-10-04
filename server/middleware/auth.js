const User = require('../models/User');
const ORGANIZATION_ROLES = new Set(['owner', 'admin', 'dispatcher', 'pilot', 'viewer']);

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Sign in to continue.' });
  }
  User.findById(req.session.userId).select('organization organizationName role name email isActive')
    .then((user) => {
      if (!user || !user.isActive) return res.status(401).json({ error: 'This account is unavailable. Sign in again.' });
      req.user = user;
      next();
    })
    .catch(next);
}

function requireOrganizationRole(...roles) {
  return function organizationRole(req, res, next) {
    if (!hasOrganizationRole(req.user, ...roles)) return res.status(403).json({ error: 'Your organization role does not allow this action.' });
    next();
  };
}

function hasOrganizationRole(user, ...roles) {
  return Boolean(user && ORGANIZATION_ROLES.has(user.role) && roles.includes(user.role));
}

function canReviewFlightPlans(user) {
  return hasOrganizationRole(user, 'owner', 'admin', 'dispatcher');
}

function isFlightAuthorityReviewer(user) {
  const reviewers = (process.env.FLIGHT_AUTHORITY_REVIEWER_EMAILS || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
  return Boolean(user && user.email && reviewers.includes(user.email.toLowerCase()));
}

function isAirspaceReviewer(user) {
  const reviewers = (process.env.AIRSPACE_REVIEWER_EMAILS || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
  return Boolean(user && reviewers.includes(user.email.toLowerCase()));
}

function requireAirspaceReviewer(req, res, next) {
  if (!isAirspaceReviewer(req.user)) return res.status(403).json({ error: 'This action is limited to configured airspace reviewers.' });
  next();
}

module.exports = {
  requireAuth, requireOrganizationRole, hasOrganizationRole, canReviewFlightPlans,
  isFlightAuthorityReviewer, isAirspaceReviewer, requireAirspaceReviewer,
};