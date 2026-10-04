const test = require('node:test');
const assert = require('node:assert/strict');
const { hasOrganizationRole } = require('./auth');

test('organization role checks grant only explicitly allowed roles', () => {
  assert.equal(hasOrganizationRole({ role: 'dispatcher' }, 'owner', 'dispatcher'), true);
  assert.equal(hasOrganizationRole({ role: 'viewer' }, 'owner', 'admin', 'dispatcher', 'pilot'), false);
  assert.equal(hasOrganizationRole({ role: 'root' }, 'owner', 'admin'), false);
  assert.equal(hasOrganizationRole(null, 'owner'), false);
});