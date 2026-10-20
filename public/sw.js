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

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/mail", self.location.origin).href;
  if (new URL(target).origin !== self.location.origin) {
    event.waitUntil(self.clients.openWindow(target));
    return;
  }
  event.waitUntil(
    rememberPending({ url: target, at: Date.now() }).then(() => self.clients.matchAll({ type: "window", includeUncontrolled: true })).then((clients) => {
      const client = clients.find((item) => new URL(item.url).origin === self.location.origin);
      if (client) {
        client.postMessage({ type: "orbit-open", url: target });
        return "focus" in client ? client.focus() : undefined;
      }
      return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "orbit-pending" || !event.ports[0]) return;
  const fresh = pending && Date.now() - pending.at < 60000 ? pending.url : null;
  pending = null;
  caches.delete(PENDING_CACHE).catch(() => undefined);
  event.ports[0].postMessage(fresh);
});
