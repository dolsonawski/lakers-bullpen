/* Lakers Bullpen — service worker (#9 PWA)
   Strategy: cache-first for the app shell (fast cold open on dugout wifi),
   but ALWAYS go to network for Firebase/Firestore (live data must never be
   served stale from cache). */
const CACHE = 'lakers-bullpen-v33';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js',
  '/firebase-data-layer.js', '/gamechanger-import.js', '/player-stats.js', '/manifest.json',
  '/block-m.png'
];

self.addEventListener('install', function (e) {
  // {cache:'reload'} bypasses the browser HTTP cache so the new cache is always
  // populated with the freshest shell — never a stale app.js/styles.css.
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) {
      return fetch(u, { cache: 'reload' })
        .then(function (r) { if (r && r.ok) return c.put(u, r); })
        .catch(function () {});
    }));
  }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  var url = e.request.url;
  // Never cache Firebase, Firestore, Google APIs, or the GAS endpoint — live data only
  if (/firebase|firestore|googleapis|google\.com|gstatic/.test(url) || e.request.method !== 'GET') {
    return; // let it hit the network normally
  }
  // App shell: cache-first, fall back to network, update cache on success
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      var net = fetch(e.request).then(function (resp) {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          var clone = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, clone); });
        }
        return resp;
      }).catch(function () { return cached; });
      return cached || net;
    })
  );
});
