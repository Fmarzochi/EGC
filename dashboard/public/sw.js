// EGC Mission Control — Service Worker
// Serves only the shell offline; all telemetry requires the local server.
const CACHE = 'egc-mc-v2';
const SHELL  = ['/', '/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Never cache API calls — always go to network
  const url = new URL(e.request.url);
  if (['/event', '/stats', '/telemetry', '/capabilities', '/ping'].includes(url.pathname)) {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
