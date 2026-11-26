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

const ANSWER_MS = 1000;

function pageAnswers(client, target) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), ANSWER_MS);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
    try {
      client.postMessage({ type: "orbit-open", url: target }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

function sendClientTo(client, target) {
  const open = () => self.clients.openWindow(target).catch(() => null);
  if (!("navigate" in client)) return open();
  return client.navigate(target).catch(open);
}

async function openFromTap(target) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = clients.find((item) => new URL(item.url).origin === self.location.origin);
  if (!client) {
    await Promise.all([rememberPending({ url: target, at: Date.now() }), self.clients.openWindow(target).catch(() => null)]);
    return;
  }
  const work = ["focus" in client ? client.focus().catch(() => null) : null];
  pending = null;
  work.push(caches.delete(PENDING_CACHE).catch(() => undefined));
  if (!(await pageAnswers(client, target))) work.push(sendClientTo(client, target));
  await Promise.all(work);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/mail", self.location.origin).href;
  if (new URL(target).origin !== self.location.origin) {
    event.waitUntil(self.clients.openWindow(target));
    return;
  }
  event.waitUntil(openFromTap(target));
});

self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "orbit-pending" || !event.ports[0]) return;
  const fresh = pending && Date.now() - pending.at < 60000 ? pending.url : null;
  pending = null;
  caches.delete(PENDING_CACHE).catch(() => undefined);
  event.ports[0].postMessage(fresh);
});
