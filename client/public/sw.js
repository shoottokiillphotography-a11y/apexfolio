/**
 * ApexFolio Service Worker
 * Handles: offline caching, background sync, push notifications
 *
 * Strategy:
 *   - App shell (HTML/CSS/JS) → Cache First
 *   - API price data          → Network First, fallback to cache
 *   - Static assets           → Cache First, update in background
 */

const CACHE_NAME     = 'apexfolio-v2';
const SHELL_CACHE    = 'apexfolio-shell-v2';
const DATA_CACHE     = 'apexfolio-data-v2';

// App shell files to cache on install
const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@400;500;600;700;800&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js',
  'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js',
];

// ─── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => {
      // Cache what we can, don't fail if some assets are unavailable
      return Promise.allSettled(
        SHELL_FILES.map(url => cache.add(url).catch(err => {
          console.warn('[SW] Failed to cache:', url, err.message);
        }))
      );
    }).then(() => {
      console.log('[SW] Shell cached');
      return self.skipWaiting(); // Activate immediately
    })
  );
});

// ─── ACTIVATE ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== SHELL_CACHE && k !== DATA_CACHE)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ─── FETCH ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Don't intercept non-GET or chrome-extension requests
  if (event.request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // API calls → Network First (fresh data), fallback to cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(event.request, DATA_CACHE, 10000));
    return;
  }

  // Price-sensitive API paths → Network Only (never serve stale prices)
  if (url.pathname.startsWith('/api/prices/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline — prices unavailable', offline: true }),
          { headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // App shell → Cache First, fallback to network, fallback to offline page
  event.respondWith(cacheFirst(event.request));
});

// ─── STRATEGIES ───────────────────────────────────────────────────────────────
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline fallback — return the app shell for navigation requests
    if (request.mode === 'navigate') {
      const shell = await caches.match('/index.html');
      if (shell) return shell;
    }
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(request, cacheName, timeoutMs = 8000) {
  const cache = await caches.open(cacheName);

  try {
    // Race network against timeout
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs)
      ),
    ]);

    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      // Add header so app knows it got stale data
      const headers = new Headers(cached.headers);
      headers.set('X-From-Cache', 'true');
      const body = await cached.text();
      return new Response(body, { status: 200, headers });
    }
    return new Response(
      JSON.stringify({ error: 'Offline and no cached data available', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ─── BACKGROUND SYNC ─────────────────────────────────────────────────────────
// Retry failed alert saves when connection is restored
self.addEventListener('sync', event => {
  if (event.tag === 'sync-alerts') {
    event.waitUntil(syncPendingAlerts());
  }
});

async function syncPendingAlerts() {
  try {
    const cache = await caches.open(DATA_CACHE);
    const pending = await cache.match('/pending-alerts');
    if (!pending) return;

    const alerts = await pending.json();
    for (const alert of alerts) {
      await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert),
      });
    }
    await cache.delete('/pending-alerts');
    console.log('[SW] Synced pending alerts');
  } catch (err) {
    console.error('[SW] Sync failed:', err);
  }
}

// ─── PUSH NOTIFICATIONS ───────────────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try { payload = event.data.json(); }
  catch { payload = { title: 'ApexFolio Alert', body: event.data.text() }; }

  const options = {
    body: payload.body || payload.message,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    tag: payload.tag || 'apexfolio-alert',
    renotify: true,
    requireInteraction: payload.requireInteraction || false,
    data: { url: payload.url || '/', ticker: payload.ticker },
    actions: [
      { action: 'view', title: 'View Portfolio' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'ApexFolio Alert', options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      const existing = windowClients.find(c => c.url === url && 'focus' in c);
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
