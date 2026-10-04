const SHELL_CACHE = 'skyledger-shell-v1';
const SCHEDULE_CACHE = 'skyledger-public-schedules-v1';
const SHELL_URLS = [
  '/',
  '/vendor/leaflet/leaflet.css',
  '/vendor/leaflet/leaflet.js',
  '/socket.io/socket.io.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => ![SHELL_CACHE, SCHEDULE_CACHE].includes(key)).map((key) => caches.delete(key)),
  )));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  const isPublicSchedule = /^\/api\/corridors(?:\/[^/]+\/(?:flights|activity|reliability|airspace))?$/.test(url.pathname)
    || url.pathname === '/api/weather';
  if (isPublicSchedule) {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(SCHEDULE_CACHE).then((cache) => cache.put(request, response.clone()));
      return response;
    }).catch(async () => (await caches.match(request)) || Response.error()));
    return;
  }

  if (request.mode === 'navigate' || url.pathname.startsWith('/vendor/leaflet/') || url.pathname === '/socket.io/socket.io.js') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(SHELL_CACHE).then((cache) => cache.put(request, response.clone()));
      return response;
    }).catch(async () => (await caches.match(request)) || (await caches.match('/')) || Response.error()));
  }
});