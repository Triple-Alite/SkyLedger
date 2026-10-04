const test = require('node:test');
const assert = require('node:assert/strict');
const { proposalResolvesConflicts, scheduleFromFix } = require('./proposals');

test('a proposed band change resolves the deck conflict', () => {
  const route = { _id: 'A', band: '300ft', startMin: 840, endMin: 860 };
  const flights = [route, { _id: 'B', band: '300ft', startMin: 840, endMin: 860 }];
  const schedule = scheduleFromFix(route, { type: 'band', value: '500ft' });

  assert.deepEqual(schedule, { band: '500ft', startMin: 840, endMin: 860 });
  assert.equal(proposalResolvesConflicts(route, flights, schedule), true);
  assert.equal(proposalResolvesConflicts(route, flights, { ...schedule, band: '300ft' }), false);
});

test('a proposed delay preserves duration', () => {
  const route = { _id: 'A', band: '300ft', startMin: 840, endMin: 860 };

  assert.deepEqual(scheduleFromFix(route, { type: 'time', value: 875 }), {
    band: '300ft', startMin: 875, endMin: 895,
  });
});