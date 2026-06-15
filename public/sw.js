/* Hoy service worker — network-first, with an offline fallback to the cached app shell.
   Bump CACHE to force clients onto a fresh app shell after a deploy. */
const CACHE = 'hoy-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // never cache POSTs (bookings, messages, payments)
  e.respondWith(
    fetch(req)
      .then((resp) => {
        // cache successful same-origin GETs so the shell works offline
        if (resp && resp.status === 200 && new URL(req.url).origin === self.location.origin) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(req).then((m) => m || caches.match('/')))
  );
});
