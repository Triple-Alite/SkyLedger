const test = require('node:test');
const assert = require('node:assert/strict');
const { router, slugBase } = require('./corridors');

test('corridor slugs are normalized and safe for API paths', () => {
  assert.equal(slugBase('Zaria – Central'), 'zaria-central');
  assert.equal(slugBase('  Lagos & Ogun  '), 'lagos-ogun');
  assert.equal(slugBase('***'), 'corridor');
});

test('corridor delete route is registered for location removal', () => {
  const hasDeleteRoute = router.stack.some((layer) =>
    layer.route && layer.route.path === '/:slug' && layer.route.methods.delete,
  );
  assert.equal(hasDeleteRoute, true);
});