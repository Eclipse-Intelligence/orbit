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
    if (url.searchParams.has("q")) url.searchParams.set("q", "search");
    return `${url.pathname}${url.search}`;
  } catch {
    return String(value);
  }
}

const ANSWER_MS = 1000;

function askPage(client, target, id) {
  return new Promise((resolve) => {
    const started = Date.now();
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve({ answered: false, ms: Date.now() - started }), ANSWER_MS);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve({ answered: true, ms: Date.now() - started });
    };
    try {
      client.postMessage({ type: "orbit-open", url: target, id }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve({ answered: false, ms: 0 });
    }
  });
}

function focusClient(client, id) {
  if (!("focus" in client)) return trail("sw-focus", { id, ok: false, reason: "no focus" });
  return client.focus().then(
    () => trail("sw-focus", { id, ok: true }),
    (error) => trail("sw-focus", { id, ok: false, reason: String(error && error.name) }),
  );
}

function sendClientTo(client, target, id) {
  if ("navigate" in client) {
    return client.navigate(target).then(
      (moved) => trail("sw-navigate", { id, how: "navigate", ok: Boolean(moved), url: moved ? pathOf(moved.url) : null }),
      (error) =>
        self.clients.openWindow(target).then(
          (opened) => trail("sw-navigate", { id, how: "open-window", reason: String(error && error.name), ok: Boolean(opened) }),
          (failure) => trail("sw-navigate", { id, how: "failed", reason: String(failure && failure.name) }),
        ),
    );
  }
  return self.clients.openWindow(target).then(
    (opened) => trail("sw-navigate", { id, how: "open-window", ok: Boolean(opened) }),
    (error) => trail("sw-navigate", { id, how: "failed", reason: String(error && error.name) }),
  );
}

async function openFromTap(target, id) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = clients.find((item) => new URL(item.url).origin === self.location.origin);
  const logged = [
    trail("sw-clients", {
      id,
      count: clients.length,
      clients: clients.map((item) => ({ url: pathOf(item.url), visibility: item.visibilityState, focused: item.focused })),
    }),
  ];
  if (!client) {
    const remembered = rememberPending({ url: target, at: Date.now(), id });
    const opened = self.clients.openWindow(target).then(
      (window) => trail("sw-open-window", { id, ok: Boolean(window), url: window ? pathOf(window.url) : null }),
      (error) => trail("sw-open-window", { id, ok: false, reason: String(error && error.name) }),
    );
    await Promise.all([remembered, opened, ...logged]);
    return;
  }
  logged.push(focusClient(client, id));
  pending = null;
  logged.push(caches.delete(PENDING_CACHE).catch(() => undefined));
  const reply = await askPage(client, target, id);
  logged.push(trail("sw-answer", { id, answered: reply.answered, ms: reply.ms }));
  if (!reply.answered) logged.push(sendClientTo(client, target, id));
  await Promise.all(logged);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const target = new URL((event.notification.data && event.notification.data.url) || "/mail", self.location.origin).href;
  const clicked = trail("sw-click", { id, url: pathOf(target) });
  if (new URL(target).origin !== self.location.origin) {
    event.waitUntil(Promise.all([clicked, self.clients.openWindow(target)]));
    return;
  }
  event.waitUntil(Promise.all([clicked, openFromTap(target, id)]));
});

self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "orbit-pending" || !event.ports[0]) return;
  const fresh = pending && Date.now() - pending.at < 60000 ? pending.url : null;
  if (pending) event.waitUntil(trail("sw-asked", { id: pending.id, fresh: Boolean(fresh), ageMs: Date.now() - pending.at }));
  pending = null;
  caches.delete(PENDING_CACHE).catch(() => undefined);
  event.ports[0].postMessage(fresh);
});
