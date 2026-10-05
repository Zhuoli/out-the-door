// Keeps the app shell (and the Transformers.js runtime) available with no signal.
// Gemma's weights are cached separately by Transformers.js in the browser Cache API.
const CACHE = 'otd-v2';
const SHELL = ['./', './index.html', './styles.css', './manifest.webmanifest', './src/app.js', './src/plan.js', './src/engines.js', './src/gemma-worker.js'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.hostname.endsWith('open-meteo.com') || u.hostname === 'localhost' || u.hostname === '127.0.0.1') return; // the app caches forecasts itself
  const shell = u.origin === location.origin || u.hostname === 'cdn.jsdelivr.net';
  if (!shell) return;
  // Network first for our own files (so updates land), cache as the no-signal fallback.
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: u.origin === location.origin })));
});
