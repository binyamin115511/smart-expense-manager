const CACHE = "expense-app-v3";
const STATIC = ["/", "/style.css", "/app.js", "/manifest.json", "/offline.html"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // API calls — always network, never cache
  if (url.pathname.startsWith("/expenses") ||
      url.pathname.startsWith("/stats") ||
      url.pathname.startsWith("/ai") ||
      url.pathname.startsWith("/login") ||
      url.pathname.startsWith("/register") ||
      url.pathname.startsWith("/me") ||
      url.pathname.startsWith("/budget") ||
      url.pathname.startsWith("/goal") ||
      url.pathname.startsWith("/foodlimit")) {
    // For navigation requests when offline, show offline page
    if (e.request.mode === "navigate") {
      e.respondWith(caches.match("/offline.html"));
    }
    return;
  }

  // Static assets — cache first, then network fallback to offline page
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => {
        if (e.request.mode === "navigate") return caches.match("/offline.html");
      });
    })
  );
});
