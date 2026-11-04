// WoundMeter service worker. It keeps only the offline page and the public, content-hashed
// build files that page needs, so a lost connection shows an explanation instead of a
// browser error. Pages, sign-in, patient data, photos and every /api/ request always go to
// the network and are never stored here, so nothing clinical (and no one's session) can be
// replayed from this device.

const CACHE_PREFIX = "woundmeter-";
// Caches written by earlier versions of this worker; removed on activation.
const LEGACY_CACHE_PREFIX = "woundwise-";
// Each production build registers /sw.js?build=<id>, so a new build installs a new worker
// with its own cache, and activation removes the previous build's cache.
const BUILD = new URLSearchParams(self.location.search).get("build") || "unversioned";
const STATIC_CACHE = `${CACHE_PREFIX}${BUILD}-static`;
const OFFLINE_URL = "/offline";

// Production chunks include a content hash. Development chunks reuse names
// such as app/page.js, so serving those from cache can hide an updated UI.
function isImmutableNextAsset(url) {
  return url.pathname.startsWith("/_next/static/") &&
    /(?:^|[-/])[a-f0-9]{8,}(?:[-.]|\/)/i.test(url.pathname);
}

// The offline page plus the CSS and JavaScript it references, read from the page itself so
// the list follows each build. The page is required; a missing asset only loses styling.
async function precacheOfflinePage() {
  const cache = await caches.open(STATIC_CACHE);
  const response = await fetch(OFFLINE_URL, { cache: "reload" });
  if (!response.ok) throw new Error(`Offline page unavailable (HTTP ${response.status})`);
  const html = await response.clone().text();
  const assets = new Set();
  for (const [, path] of html.matchAll(/(?:\/_next\/)?(static\/(?:chunks|css|media)\/[^"'\\\s?#)]+)/g)) {
    const url = new URL(`/_next/${path}`, self.location.origin);
    if (isImmutableNextAsset(url)) assets.add(url.href);
  }
  await Promise.all([...assets].map((asset) => cache.add(asset).catch(() => undefined)));
  await cache.put(OFFLINE_URL, response);
}

self.addEventListener("install", (event) => {
  // Activating at once is safe: this worker never serves pages or data from its cache, so a
  // new version cannot change an open screen, and requests already in flight are unaffected.
  event.waitUntil(precacheOfflinePage().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => (key.startsWith(CACHE_PREFIX) || key.startsWith(LEGACY_CACHE_PREFIX)) && key !== STATIC_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  // Content-hashed files never change, so header variations (Vary) cannot matter.
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    await cache.put(request, response.clone());
  }
  return response;
}

async function offlinePage() {
  const cache = await caches.open(STATIC_CACHE);
  return (await cache.match(OFFLINE_URL, { ignoreVary: true })) ||
    new Response("WoundMeter can't be reached. Check your connection, then try again.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Sign-in, patient records, photos, measurements and uploads: network only, never cached.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    // Pages are never stored. Offline, the browser gets the explanation page instead.
    event.respondWith(fetch(request).catch(() => offlinePage()));
    return;
  }

  if (isImmutableNextAsset(url)) {
    event.respondWith(cacheFirst(request));
  }
});
