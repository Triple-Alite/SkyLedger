const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAircraft } = require('./aircraft');

test('aircraft profiles require a name and a bounded endurance', () => {
  assert.equal(validateAircraft({ name: 'Kestrel 2', enduranceMin: 45 }), null);
  assert.match(validateAircraft({ name: 'A', enduranceMin: 45 }), /Aircraft name/);
  assert.match(validateAircraft({ name: 'Kestrel 2', enduranceMin: 0 }), /endurance/);
  assert.match(validateAircraft({ name: 'Kestrel 2', enduranceMin: 45, registration: 'x'.repeat(41) }), /registration/);
});