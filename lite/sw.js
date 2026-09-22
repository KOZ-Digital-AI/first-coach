/* FIRST COACH service worker: cache the whole app so it opens offline after the first visit. */
const CACHE = 'first-coach-lite-v10';
const ASSETS = [
  './', 'index.html', 'css/app.css?v=10', 'js/data.js?v=10', 'js/i18n.js?v=10', 'js/anim.js?v=10', 'js/app.js?v=10', 'commons.json',
  'manifest.webmanifest', 'icons/favicon.svg', 'icons/pwa-192x192.png', 'icons/pwa-512x512.png', 'icons/maskable-512x512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first for the app itself (so updates land), cache fallback when offline; cache first for fonts.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match('index.html')))
    );
  } else if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    e.respondWith(
      caches.match(req).then(r => r || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }))
    );
  }
});
