/* sw.js — rende Vintify utilizzabile offline dopo la prima visita.
 * Mette in cache solo i file del sito (non il modello AI, che è già nella cache HTTP del browser).
 */
const CACHE = 'vintify-v1';
const ASSETS = [
  './',
  './index.html',
  './pipeline.js',
  './worker.js',
  './vendor/imgly-loader.mjs',
  './assets/demo_shirt_before.jpg',
  './assets/demo_shirt_after.jpg',
  './assets/demo_sneakers_before.jpg',
  './assets/demo_sneakers_after.jpg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // il modello CDN va in cache HTTP
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
