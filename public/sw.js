"use strict";

// Service worker : rend le panneau installable comme une appli, et remplace la page d'erreur
// de Cloudflare (tunnel coupé pendant un redémarrage) par une page « Le serveur redémarre »
// qui se recharge toute seule. Seule cette page de secours est mise en cache : les données
// viennent toujours du serveur.

const CACHE = "offline-v6"; // à changer quand les fichiers de la page de secours changent
const OFFLINE_FILES = ["offline.html", "offline.css", "offline.js", "icons/icon.svg"];
// 530 = erreur Cloudflare (tunnel injoignable, ex. erreur 1033) ; 502-504 = passerelle
const DOWN_STATUSES = new Set([502, 503, 504, 530]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(OFFLINE_FILES.map((f) => new Request(f, { credentials: "same-origin" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function offlinePage() {
  const cached = await caches.match("offline.html");
  return cached
    ? new Response(cached.body, { status: 503, headers: cached.headers })
    : new Response("Le serveur redémarre, réessaie dans une minute.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Fichiers de la page de secours : toujours depuis le cache. Pendant une coupure, Cloudflare
  // ne fait pas échouer la requête, il renvoie sa page d'erreur (530) : on ne peut pas s'y fier.
  if (OFFLINE_FILES.some((f) => url.pathname === `/${f}`)) {
    event.respondWith(caches.match(url.pathname.slice(1)).then((cached) => cached || fetch(request)));
    return;
  }

  // Seules les navigations (ouverture/rechargement de page) sont interceptées
  if (request.mode !== "navigate") return;
  event.respondWith(
    fetch(request)
      .then((res) => (DOWN_STATUSES.has(res.status) ? offlinePage() : res))
      .catch(() => offlinePage())
  );
});

// --- Notifications push : alertes envoyées par le serveur (débuts de live, mentions…) ---

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  // Pastille chiffrée sur l'icône de l'appli installée (là où le système la gère)
  if (Number.isInteger(data.unseen)) self.navigator.setAppBadge?.(data.unseen).catch(() => {});
  event.waitUntil(self.registration.showNotification(data.title || "Twitch Deck", {
    body: data.body || "",
    icon: data.icon || "icons/icon-192.png",
    badge: "icons/icon-192.png",
    image: data.image,
    tag: data.tag,
    renotify: Boolean(data.tag),
    silent: Boolean(data.silent),
    data: { channel: data.channel || null },
  }));
});

// Appui sur la notification : ouvre Twitch Deck sur la fiche de la chaîne concernée, en réutilisant
// le panneau s'il est déjà ouvert
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const channel = event.notification.data?.channel;
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const panel = tabs.find((t) => new URL(t.url).origin === self.location.origin);
    if (panel) {
      if (channel) panel.postMessage({ openChannel: channel });
      return panel.focus();
    }
    return self.clients.openWindow(channel ? `/?chaine=${encodeURIComponent(channel)}` : "/");
  })());
});
