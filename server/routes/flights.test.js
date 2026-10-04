const test = require('node:test');
const assert = require('node:assert/strict');
const FlightPlan = require('../models/FlightPlan');
const { isFlightAuthorityReviewer } = require('../middleware/auth');
const {
  canManage, letterFor, router, validateAuthorityRecord, validateFeedback,
  validateFlight, validateInternalApproval, resetFlightDecisions, decisionResetNote,
} = require('./flights');

test('flight decision endpoints are separately registered', () => {
  const routes = router.stack.filter((layer) => layer.route).map((layer) => {
    return Object.keys(layer.route.methods).join(',') + ' ' + layer.route.path;
  });

  assert.ok(routes.includes('patch /flights/:id/internal-approval'));
  assert.ok(routes.includes('get /flights/:id/review-record'));
  assert.ok(routes.includes('patch /flights/:id/authority-clearance'));
});

test('new flight plans separate team approval from external authority clearance', () => {
  const flight = new FlightPlan();

  assert.equal(flight.internalApprovalStatus, 'pending');
  assert.equal(flight.authorityClearanceStatus, 'not-requested');
});

test('flight letters continue globally beyond Z', () => {
  assert.equal(letterFor(1), 'A');
  assert.equal(letterFor(26), 'Z');
  assert.equal(letterFor(27), 'AA');
});

test('flight request validation accepts valid same-day plans and rejects invalid windows', () => {
  const flight = {
    operator: 'Nimbus Health',
    from: 'Kaduna Hub',
    to: 'Giwa Clinic',
    payload: 'medical',
    band: '300ft',
    flightDate: '2026-10-04',
    waypoints: [{ lat: 9.05, lng: 7.49 }, { lat: 9.1, lng: 7.55 }],
    startMin: 840,
    endMin: 860,
  };

  assert.equal(validateFlight(flight), null);
  assert.match(validateFlight({ ...flight, endMin: 840 }), /valid same-day interval/);
  assert.match(validateFlight({ ...flight, flightDate: '2026-02-30' }), /valid flight date/);
  assert.match(validateFlight({ ...flight, waypoints: [{ lat: 99, lng: 7 }] }), /map waypoints/);
  assert.match(validateFlight({ ...flight, batteryStartPercent: 101 }), /0 to 100/);
  assert.match(validateFlight({ ...flight, payloadDetails: 'x'.repeat(201) }), /Payload details/);
  assert.match(validateFlight({ ...flight, band: '600ft' }), /band is invalid/);
});

test('post-flight feedback requires valid actual times and disruption category', () => {
  const feedback = { actualStartMin: 840, actualEndMin: 865, disruption: 'delay', outcomeNotes: 'Held for traffic.' };
  assert.equal(validateFeedback(feedback), null);
  assert.match(validateFeedback({ ...feedback, actualEndMin: 840 }), /actual departure and arrival/);
  assert.match(validateFeedback({ ...feedback, disruption: 'unknown' }), /disruption category/);
});

test('organization roles manage plans only within their organization', () => {
  const flight = { owner: 'pilot-1', organization: 'org-1', isDemo: false };
  assert.equal(canManage(flight, { _id: 'dispatcher-1', organization: 'org-1', role: 'dispatcher' }), true);
  assert.equal(canManage(flight, { _id: 'viewer-1', organization: 'org-1', role: 'viewer' }), false);
  assert.equal(canManage(flight, { _id: 'admin-2', organization: 'org-2', role: 'admin' }), false);
  assert.equal(canManage(flight, { _id: 'pilot-1', organization: 'org-1', role: 'pilot' }), true);
});

test('team approval accepts only final review decisions', () => {
  assert.equal(validateInternalApproval({ status: 'approved', notes: 'Reviewed.' }), null);
  assert.match(validateInternalApproval({ status: 'pending' }), /Choose approved or rejected/);
  assert.match(validateInternalApproval({ status: 'rejected', notes: 'x'.repeat(501) }), /at most 500/);
});

test('authority clearance requires an authority and decision reference', () => {
  const flightDate = '2026-10-04';
  assert.equal(validateAuthorityRecord({ status: 'pending', authorityName: 'NCAA' }, flightDate), null);
  assert.match(validateAuthorityRecord({ status: 'cleared', authorityName: 'NCAA' }, flightDate), /decision reference/);
  assert.equal(validateAuthorityRecord({ status: 'cleared', authorityName: 'NCAA', authorityReference: 'CLR-42', validUntil: '2026-10-04' }, flightDate), null);
  assert.match(validateAuthorityRecord({ status: 'cleared', authorityName: 'NCAA', authorityReference: 'CLR-42', validUntil: '2026-10-03' }, flightDate), /cannot be before the flight date/);
});

test('only configured authority reviewer emails can record external decisions', () => {
  const previous = process.env.FLIGHT_AUTHORITY_REVIEWER_EMAILS;
  process.env.FLIGHT_AUTHORITY_REVIEWER_EMAILS = 'authority@example.com, ops@authority.example';

  try {
    assert.equal(isFlightAuthorityReviewer({ email: 'Authority@Example.com' }), true);
    assert.equal(isFlightAuthorityReviewer({ email: 'pilot@example.com' }), false);
  } finally {
    if (previous == null) delete process.env.FLIGHT_AUTHORITY_REVIEWER_EMAILS;
    else process.env.FLIGHT_AUTHORITY_REVIEWER_EMAILS = previous;
  }
});

test('schedule changes reopen team review and supersede prior authority clearance', () => {
  const flight = {
    internalApprovalStatus: 'approved',
    internalApprovalReviewedBy: 'reviewer-1',
    internalApprovalReviewedAt: new Date(),
    internalApprovalNotes: 'Reviewed route.',
    authorityClearanceStatus: 'cleared',
    authorityName: 'NCAA',
    authorityReference: 'CLR-42',
    authorityValidUntil: new Date('2026-10-04T00:00:00.000Z'),
    authorityNotes: 'Confirmed against authority notice.',
    authorityRecordedBy: 'authority-1',
    authorityRecordedAt: new Date(),
  };

  const previous = resetFlightDecisions(flight);
  assert.equal(flight.internalApprovalStatus, 'pending');
  assert.equal(flight.internalApprovalReviewedBy, null);
  assert.equal(flight.internalApprovalNotes, '');
  assert.equal(flight.authorityClearanceStatus, 'not-requested');
  assert.equal(flight.authorityReference, '');
  assert.match(decisionResetNote(previous), /CLR-42.*superseded/);
});