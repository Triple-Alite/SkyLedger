const turf = require('@turf/turf');

const BANDS = ['200ft', '300ft', '400ft', '500ft'];
const HORIZONTAL_SEPARATION_KM = 0.1;

function overlaps(start1, end1, start2, end2) {
  return start1 < end2 && start2 < end1;
}

function toLine(route) {
  if (!Array.isArray(route.waypoints) || route.waypoints.length < 2) return null;
  return turf.lineString(route.waypoints.map((point) => [point.lng, point.lat]));
}

function pathsConflict(route, candidate) {
  const start = Math.max(route.startMin, candidate.startMin);
  const end = Math.min(route.endMin, candidate.endMin);
  if (start >= end || (route.flightDate || '') !== (candidate.flightDate || '')) return false;

  const routeLine = toLine(route);
  const candidateLine = toLine(candidate);
  if (!routeLine || !candidateLine) return false;

  const routeLength = turf.length(routeLine, { units: 'kilometers' });
  const candidateLength = turf.length(candidateLine, { units: 'kilometers' });
  const duration = end - start;
  const steps = Math.min(1800, Math.max(1, Math.ceil(duration * 12)));

  for (let step = 0; step <= steps; step += 1) {
    const minute = start + (duration * step) / steps;
    const routeFraction = Math.max(0, Math.min(1, (minute - route.startMin) / (route.endMin - route.startMin)));
    const candidateFraction = Math.max(0, Math.min(1, (minute - candidate.startMin) / (candidate.endMin - candidate.startMin)));
    const routePosition = turf.along(routeLine, routeLength * routeFraction, { units: 'kilometers' });
    const candidatePosition = turf.along(candidateLine, candidateLength * candidateFraction, { units: 'kilometers' });
    if (turf.distance(routePosition, candidatePosition, { units: 'kilometers' }) <= HORIZONTAL_SEPARATION_KM) {
      return true;
    }
  }
  return false;
}

function findConflicts(route, allRoutesInCorridor, excludeId) {
  return allRoutesInCorridor.filter((candidate) => {
    const candidateId = String(candidate._id ?? candidate.id ?? candidate.letter);
    if (candidateId === String(excludeId) || candidate.band !== route.band
        || !overlaps(route.startMin, route.endMin, candidate.startMin, candidate.endMin)) return false;
    if (toLine(route) && toLine(candidate)) return pathsConflict(route, candidate);
    return true;
  });
}

function suggestFix(route, allRoutesInCorridor, excludeId) {
  for (const band of BANDS.slice().reverse()) {
    if (band === route.band) continue;
    const testRoute = { ...(route.toObject ? route.toObject() : route), band };
    if (findConflicts(testRoute, allRoutesInCorridor, excludeId).length === 0) {
      return { type: 'band', value: band };
    }
  }

  const conflicts = findConflicts(route, allRoutesInCorridor, excludeId);
  const latestEnd = Math.max(...conflicts.map((candidate) => candidate.endMin));
  return { type: 'time', value: latestEnd };
}

module.exports = { BANDS, HORIZONTAL_SEPARATION_KM, overlaps, pathsConflict, findConflicts, suggestFix };