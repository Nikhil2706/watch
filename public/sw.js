// App-shell service worker. Caches static assets and the login page so the
// shell loads instantly on repeat visits and login still renders offline.
// Deliberately NOT caching video/streaming (/jf/*, /watch/*) or anything
// API/auth-related — those need to stay live, and caching them risks
// serving a stale session state. Phase 3 (real downloads) gets its own
// separate storage path entirely; this cache is shell-only.

// Bumped to v2 with the aperture icon set. The activate handler deletes every
// cache that is not CACHE_NAME, so bumping this is what makes an already
// installed app drop the old icons instead of keeping them forever.
const CACHE_NAME = "watch-shell-v2";
const PRECACHE_URLS = ["/login", "/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

const NEVER_CACHE = [/^\/jf\//, /^\/watch\//, /^\/api\//];

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some((pattern) => pattern.test(url.pathname))) return;

  // Next's own static assets are content-hashed under /_next/static/ —
  // immutable, so cache-first is always safe and never goes stale.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      }),
    );
    return;
  }

  // Everything else (pages, icons, manifest): network-first, falling back
  // to cache when offline. Only the login page is guaranteed precached;
  // other pages cache opportunistically as they're visited.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("/login"))),
  );
});
