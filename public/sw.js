self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Orbit", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Orbit";
  const work = [
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url || "/mail" },
    }),
  ];
  if (typeof data.badge === "number" && self.navigator && "setAppBadge" in self.navigator) {
    work.push(data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge());
  }
  event.waitUntil(Promise.all(work).catch(() => undefined));
});

let pending = null;

const PENDING_CACHE = "orbit-pending";
const PENDING_KEY = "/__orbit-pending";

function rememberPending(value) {
  pending = value;
  return caches
    .open(PENDING_CACHE)
    .then((cache) => cache.put(PENDING_KEY, new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })))
    .catch(() => undefined);
}

function trail(step, data) {
  return fetch("/api/push/trail", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step, data: { ...data, at: new Date().toISOString() } }),
    keepalive: true,
  }).catch(() => undefined);
}

function pathOf(value) {
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  } catch {
    return String(value);
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const target = new URL((event.notification.data && event.notification.data.url) || "/mail", self.location.origin).href;
  const logged = [trail("sw-click", { id, url: pathOf(target) })];
  if (new URL(target).origin !== self.location.origin) {
    event.waitUntil(Promise.all([...logged, self.clients.openWindow(target)]));
    return;
  }
  event.waitUntil(
    rememberPending({ url: target, at: Date.now(), id })
      .then(() => self.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .then((clients) => {
        logged.push(
          trail("sw-clients", {
            id,
            count: clients.length,
            clients: clients.map((item) => ({ url: pathOf(item.url), visibility: item.visibilityState, focused: item.focused })),
          }),
        );
        const client = clients.find((item) => new URL(item.url).origin === self.location.origin);
        if (client) {
          client.postMessage({ type: "orbit-open", url: target, id });
          if (!("focus" in client)) return trail("sw-focus", { id, ok: false, reason: "no focus" });
          return client.focus().then(
            () => trail("sw-focus", { id, ok: true }),
            (error) => trail("sw-focus", { id, ok: false, reason: String(error && error.name) }),
          );
        }
        return self.clients.openWindow(target).then(
          (opened) => trail("sw-open-window", { id, ok: Boolean(opened), url: opened ? pathOf(opened.url) : null }),
          (error) => trail("sw-open-window", { id, ok: false, reason: String(error && error.name) }),
        );
      })
      .then(() => Promise.all(logged)),
  );
});

self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "orbit-pending" || !event.ports[0]) return;
  const fresh = pending && Date.now() - pending.at < 60000 ? pending.url : null;
  if (pending) event.waitUntil(trail("sw-asked", { id: pending.id, fresh: Boolean(fresh), ageMs: Date.now() - pending.at }));
  pending = null;
  caches.delete(PENDING_CACHE).catch(() => undefined);
  event.ports[0].postMessage(fresh);
});
