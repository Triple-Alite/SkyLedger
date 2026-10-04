const test = require('node:test');
const assert = require('node:assert/strict');
const FlightPlan = require('../models/FlightPlan');
const { findConflicts, suggestFix } = require('./conflicts');

test('deck scenario flags A and B and suggests the highest free band', () => {
  const routes = [
    { letter: 'A', band: '300ft', startMin: 840, endMin: 860 },
    { letter: 'B', band: '300ft', startMin: 840, endMin: 860 },
  ];

  assert.deepEqual(findConflicts(routes[0], routes, 'A').map((route) => route.letter), ['B']);
  assert.deepEqual(suggestFix(routes[0], routes, 'A'), { type: 'band', value: '500ft' });
});

test('when every altitude band is occupied, the fix delays until the latest conflict ends', () => {
  const routes = [
    { letter: 'A', band: '200ft', startMin: 600, endMin: 635 },
    { letter: 'B', band: '300ft', startMin: 600, endMin: 625 },
    { letter: 'C', band: '400ft', startMin: 600, endMin: 630 },
    { letter: 'D', band: '500ft', startMin: 600, endMin: 620 },
  ];
  const route = { letter: 'E', band: '200ft', startMin: 600, endMin: 620 };

  assert.deepEqual(suggestFix(route, routes, 'E'), { type: 'time', value: 635 });
});

test('suggestFix reads Mongoose flight documents when testing candidate bands', () => {
  const route = new FlightPlan({ letter: 'E', band: '300ft', startMin: 600, endMin: 620 });
  const routes = [
    { letter: 'A', band: '300ft', startMin: 600, endMin: 620 },
    { letter: 'B', band: '400ft', startMin: 600, endMin: 620 },
    { letter: 'C', band: '500ft', startMin: 600, endMin: 620 },
  ];

  assert.deepEqual(suggestFix(route, routes, route._id), { type: 'band', value: '200ft' });
});

test('geographic crossings conflict only when the routes are co-located at the same time', () => {
  const route = {
    letter: 'A', band: '300ft', flightDate: '2026-10-04', startMin: 600, endMin: 660,
    waypoints: [{ lat: 0, lng: -1 }, { lat: 0, lng: 1 }],
  };
  const simultaneous = {
    letter: 'B', band: '300ft', flightDate: '2026-10-04', startMin: 600, endMin: 660,
    waypoints: [{ lat: -1, lng: 0 }, { lat: 1, lng: 0 }],
  };
  const timeSeparated = {
    ...simultaneous, letter: 'C', startMin: 600, endMin: 630,
  };

  assert.deepEqual(findConflicts(route, [simultaneous], 'A').map((flight) => flight.letter), ['B']);
  assert.deepEqual(findConflicts(route, [timeSeparated], 'A'), []);
  assert.deepEqual(findConflicts(route, [{ ...simultaneous, flightDate: '2026-10-05' }], 'A'), []);
});