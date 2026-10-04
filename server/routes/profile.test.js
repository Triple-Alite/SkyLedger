const test = require('node:test');
const assert = require('node:assert/strict');
const { router, validateAccountDeletion, validateProfileUpdate } = require('./profile');

test('profile routes expose authenticated profile read and update endpoints', () => {
  const routes = router.stack.filter((layer) => layer.route).map((layer) => {
    return Object.keys(layer.route.methods).join(',') + ' ' + layer.route.path;
  });

  assert.ok(routes.includes('get /'));
  assert.ok(routes.includes('patch /'));
  assert.ok(routes.includes('delete /'));
});

test('profile name can be updated while organization rename is role-restricted', () => {
  assert.equal(validateProfileUpdate({ name: 'Pilot One' }, 'pilot'), null);
  assert.equal(validateProfileUpdate({ organizationName: 'Northstar Air' }, 'owner'), null);
  assert.equal(validateProfileUpdate({ organizationName: 'Northstar Air' }, 'admin'), null);
  assert.match(validateProfileUpdate({ organizationName: 'Northstar Air' }, 'pilot'), /Only an owner or admin/);
  assert.match(validateProfileUpdate({ name: 'A' }, 'pilot'), /2 to 80/);
  assert.match(validateProfileUpdate({ organizationName: 'A' }, 'owner'), /2 to 100/);
  assert.match(validateProfileUpdate({}, 'owner'), /at least one/);
});

test('account deletion requires password confirmation and a valid optional successor', () => {
  assert.equal(validateAccountDeletion({ password: 'current-password' }), null);
  assert.equal(validateAccountDeletion({ password: 'current-password', transferToUserId: 'user-2' }), null);
  assert.match(validateAccountDeletion({}), /current password/);
  assert.match(validateAccountDeletion({ password: 'current-password', transferToUserId: {} }), /valid successor/);
});