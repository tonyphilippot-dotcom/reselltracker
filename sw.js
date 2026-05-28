const CACHE = 'reselltracker-v30';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // 🛡️ NETWORK FIRST pour HTML et JS (toujours dernière version)
  const url = new URL(e.request.url);
  const isAppFile = url.pathname.endsWith('.html') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('/') || url.pathname.endsWith('.json');
  if (isAppFile) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return resp;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    // Pour les autres ressources (images, etc.) : cache first
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
