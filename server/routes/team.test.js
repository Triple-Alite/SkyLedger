const test = require('node:test');
const assert = require('node:assert/strict');
const { validateInvitation } = require('./team');

test('team invitations accept supported roles and protect admin assignment', () => {
  assert.equal(validateInvitation('pilot@example.com', 'pilot', 'owner'), null);
  assert.match(validateInvitation('not-email', 'pilot', 'owner'), /valid email/);
  assert.match(validateInvitation('pilot@example.com', 'owner', 'owner'), /Choose admin/);
  assert.match(validateInvitation('admin@example.com', 'admin', 'admin'), /Only an owner/);
});