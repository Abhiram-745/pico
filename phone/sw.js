/* ==========================================================================
   Halo phone companion — service worker

   The shell is cached so the app opens instantly from the home screen even
   before the laptop answers. Live agent state is never cached: it arrives
   over the WebSocket, which the service worker does not touch.
   ========================================================================== */

/* Bumped whenever the shell list or the name changes, so an installed phone
   drops the old cache rather than serving a mix of the two. */
const VERSION = 'halo-phone-v4';

const SHELL = [
  './',
  './index.html',
  './phone.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  '../pico-ui/src/theme.css',
  '../pico-ui/src/motion.css',
  '../pico-ui/src/palette.css',
  '../pico-ui/src/store.js',
  '../pico-ui/src/bridge.js',
  '../pico-ui/src/mascot.js',
  '../pico-ui/src/cards.js',
  '../pico-ui/assets/pico.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // Individual failures must not abort the whole install.
      .then((cache) => Promise.all(
        SHELL.map((url) => cache.add(url).catch(() => null)),
      ))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Pairing endpoints are live state — never serve them from cache.
  if (url.pathname.startsWith('/pair.')) return;

  // Network-first for navigations so a laptop-side update is picked up,
  // falling back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || Response.error())),
    );
    return;
  }

  // Cache-first for the static shell.
  event.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
      }
      return res;
    })),
  );
});
