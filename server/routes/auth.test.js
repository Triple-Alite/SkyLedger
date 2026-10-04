const test = require('node:test');
const assert = require('node:assert/strict');
const { router, publicUser, validatePassword, validateSignup, validateVerificationCode } = require('./auth');

test('email verification routes are registered for secure signup flow', () => {
  const routePaths = router.stack
    .filter((layer) => layer.route)
    .map((layer) => Object.keys(layer.route.methods).join(',') + ' ' + layer.route.path);

  assert.ok(routePaths.includes('post /signup'));
  assert.ok(routePaths.includes('post /verify-email'));
  assert.ok(routePaths.includes('post /resend-verification'));
  assert.ok(routePaths.includes('get /validate-verification-token/:token'));
});

test('email verification requires a six-digit code', () => {
  assert.equal(validateVerificationCode('042681'), null);
  assert.match(validateVerificationCode('42681'), /six-digit/);
  assert.match(validateVerificationCode('42a681'), /six-digit/);
});

test('signup accepts valid credentials and enforces password boundaries', () => {
  assert.equal(validateSignup('Northstar Air', 'Ada Pilot', 'ada@example.com', 'secure-pass-123'), null);
  assert.match(validateSignup('N', 'Ada Pilot', 'ada@example.com', 'secure-pass-123'), /Organization name must/);
  assert.match(validateSignup('Northstar Air', 'A', 'ada@example.com', 'secure-pass-123'), /Name must/);
  assert.match(validateSignup('Northstar Air', 'Ada Pilot', 'not-an-email', 'secure-pass-123'), /valid email/);
  assert.match(validateSignup('Northstar Air', 'Ada Pilot', 'ada@example.com', 'short'), /Password must/);
  assert.equal(validateSignup('', 'Ada Pilot', 'ada@example.com', 'secure-pass-123', true), null);
});

test('password validation enforces reset requirements consistently', () => {
  assert.equal(validatePassword('secure-pass-123'), null);
  assert.match(validatePassword('short'), /between 8 and 72 bytes/);
  assert.match(validatePassword('a'.repeat(73)), /between 8 and 72 bytes/);
});

test('account responses include organization name and support older accounts', () => {
  assert.deepEqual(publicUser({ _id: 'user-1', organization: 'org-1', role: 'owner', organizationName: 'Northstar Air', name: 'Ada Pilot', email: 'ada@example.com' }), {
    id: 'user-1', organizationName: 'Northstar Air', organizationId: 'org-1', role: 'owner', canReviewFlightPlans: true, canRecordAuthorityDecision: false, canReviewAirspace: false, name: 'Ada Pilot', email: 'ada@example.com', emailVerified: false,
  });
  const legacyUser = publicUser({ _id: 'user-2', name: 'Legacy Pilot', email: 'legacy@example.com' });
  assert.equal(legacyUser.organizationName, 'Legacy Pilot');
  assert.equal(legacyUser.role, 'owner');
  assert.equal(legacyUser.emailVerified, false);
});