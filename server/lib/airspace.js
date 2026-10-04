const turf = require('@turf/turf');

const CATEGORIES = new Set(['restricted', 'no-fly', 'caution']);

function validateAirspaceZone(body) {
  if (typeof body.name !== 'string' || body.name.trim().length < 3 || body.name.trim().length > 100) {
    return { error: 'Restriction name must be 3 to 100 characters.' };
  }
  if (!CATEGORIES.has(body.category)) return { error: 'Choose restricted, no-fly, or caution.' };
  if (typeof body.sourceName !== 'string' || body.sourceName.trim().length < 2 || body.sourceName.trim().length > 120) {
    return { error: 'Provide the name of the source.' };
  }
  if (typeof body.sourceUrl !== 'string' || body.sourceUrl.length > 500) return { error: 'Provide a source URL.' };
  let sourceUrl;
  try {
    sourceUrl = new URL(body.sourceUrl);
  } catch (error) {
    return { error: 'Source URL must be a valid HTTPS link.' };
  }
  if (sourceUrl.protocol !== 'https:') return { error: 'Source URL must use HTTPS.' };
  const checkedAt = body.sourceCheckedAt ? new Date(body.sourceCheckedAt + 'T00:00:00.000Z') : new Date();
  if (Number.isNaN(checkedAt.getTime())
      || (body.sourceCheckedAt && checkedAt.toISOString().slice(0, 10) !== body.sourceCheckedAt)
      || checkedAt > new Date()) return { error: 'Choose a valid source-check date that is not in the future.' };

  const geometry = body.geometry && body.geometry.type === 'Feature' ? body.geometry.geometry : body.geometry;
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
    return { error: 'Import a Polygon or MultiPolygon GeoJSON geometry.' };
  }
  try {
    if (!turf.booleanValid(turf.feature(geometry))) return { error: 'The restriction geometry is invalid GeoJSON.' };
  } catch (error) {
    return { error: 'The restriction geometry is invalid GeoJSON.' };
  }
  return { value: { ...body, geometry, sourceName: body.sourceName.trim(), sourceUrl: sourceUrl.href, sourceCheckedAt: checkedAt } };
}

module.exports = { CATEGORIES, validateAirspaceZone };