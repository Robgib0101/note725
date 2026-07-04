const CACHE_NAME = "really-notepad-box-menu-v16";
const BASE_PATH = new URL("./", self.location).pathname;

const CORE_ASSETS = [
  BASE_PATH,
  `${BASE_PATH}index.html`,
  `${BASE_PATH}about.html`,
  `${BASE_PATH}guide.html`,
  `${BASE_PATH}privacy.html`,
  `${BASE_PATH}terms.html`,
  `${BASE_PATH}contact.html`,
  `${BASE_PATH}style.css`,
  `${BASE_PATH}main.js`,
  `${BASE_PATH}firebase-config.js`,
  `${BASE_PATH}manifest.webmanifest`,
  `${BASE_PATH}assets/productivity-workspace.png`,
  `${BASE_PATH}src/dom.js`,
  `${BASE_PATH}src/export.js`,
  `${BASE_PATH}src/firestore.js`,
  `${BASE_PATH}src/images.js`,
  `${BASE_PATH}src/storage.js`,
  `${BASE_PATH}src/text.js`
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match(BASE_PATH)))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }

        return response;
      });
    })
  );
});
