const { findConflicts } = require('./conflicts');

function scheduleFromFix(route, fix) {
  if (fix.type === 'band') {
    return { band: fix.value, startMin: route.startMin, endMin: route.endMin };
  }
  const duration = route.endMin - route.startMin;
  return { band: route.band, startMin: fix.value, endMin: fix.value + duration };
}

function proposalResolvesConflicts(route, flights, schedule) {
  return findConflicts({ ...route.toObject?.() ?? route, ...schedule }, flights, route._id).length === 0;
}

module.exports = { scheduleFromFix, proposalResolvesConflicts };