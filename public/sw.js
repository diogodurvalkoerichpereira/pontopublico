const CACHE = "meu-ponto-shell-v15";
const SHELL = ["/offline.html", "/manifest.webmanifest", "/pwa-icon.svg"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/offline.html")),
    );
    return;
  }
  if (!["style", "script", "image", "font"].includes(event.request.destination))
    return;
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((response) => {
          if (response.ok)
            caches
              .open(CACHE)
              .then((cache) => cache.put(event.request, response.clone()));
          return response;
        }),
    ),
  );
});
self.addEventListener("push", (event) => {
  const data = event.data?.json?.() ?? {
    title: "Meu Ponto",
    body: "Você recebeu uma atualização.",
  };
  event.waitUntil(
    self.registration.showNotification(data.title || "Meu Ponto", {
      body: data.body,
      icon: "/pwa-icon.svg",
      badge: "/pwa-icon.svg",
      data: { url: data.url || "/" },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || "/"));
});
