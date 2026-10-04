const test = require('node:test');
const assert = require('node:assert/strict');
const AirspaceZone = require('../models/AirspaceZone');
const { validateAirspaceZone } = require('./airspace');
const { isAirspaceReviewer } = require('../middleware/auth');

const validZone = {
  name: 'Airport buffer',
  category: 'caution',
  sourceName: 'Local aviation notice',
  sourceUrl: 'https://example.org/notice',
  sourceCheckedAt: '2026-10-03',
  geometry: { type: 'Polygon', coordinates: [[[7, 9], [7.1, 9], [7.1, 9.1], [7, 9.1], [7, 9]]] },
};

test('airspace overlays require valid polygon GeoJSON and a timestampable HTTPS source', () => {
  assert.equal(validateAirspaceZone(validZone).value.geometry.type, 'Polygon');
  assert.match(validateAirspaceZone({ ...validZone, sourceUrl: 'http://example.org' }).error, /HTTPS/);
  assert.match(validateAirspaceZone({ ...validZone, sourceCheckedAt: '2026-02-30' }).error, /source-check date/);
  assert.match(validateAirspaceZone({ ...validZone, geometry: { type: 'Point', coordinates: [7, 9] } }).error, /Polygon/);
});

test('airspace imports are pending until review and reviewers come from server configuration', () => {
  const zone = new AirspaceZone({ sourceType: 'community' });
  assert.equal(zone.reviewStatus, 'pending');
  const previous = process.env.AIRSPACE_REVIEWER_EMAILS;
  process.env.AIRSPACE_REVIEWER_EMAILS = 'reviewer@example.com';
  assert.equal(isAirspaceReviewer({ email: 'REVIEWER@example.com' }), true);
  assert.equal(isAirspaceReviewer({ email: 'other@example.com' }), false);
  if (previous === undefined) delete process.env.AIRSPACE_REVIEWER_EMAILS;
  else process.env.AIRSPACE_REVIEWER_EMAILS = previous;
});