export type PushState = "unsupported" | "install" | "blocked" | "off" | "on";

function base64ToBytes(value: string) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

export function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function isAppleMobile() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => null);
}

async function saveSubscription(subscription: PushSubscription) {
  const response = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!response.ok) throw new Error("Orbit couldn't save this device. Try again.");
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isAppleMobile() && !isStandalone() ? "install" : "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted") return "off";
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? "on" : "off";
}

export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications are blocked for Orbit. Allow them in your device settings." : "Notifications weren't turned on.");
  await registerServiceWorker();
  const registration = await navigator.serviceWorker.ready;
  const keyResponse = await fetch("/api/push/key", { cache: "no-store" });
  const { publicKey } = (await keyResponse.json()) as { publicKey: string };
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(publicKey) }));
  await saveSubscription(subscription);
}

export async function disablePush() {
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await fetch(`/api/push/subscribe?endpoint=${encodeURIComponent(subscription.endpoint)}`, { method: "DELETE" }).catch(() => null);
  await subscription.unsubscribe().catch(() => false);
}

export async function refreshPush() {
  if (!pushSupported() || Notification.permission !== "granted") return;
  const registration = await registerServiceWorker();
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) await saveSubscription(subscription).catch(() => null);
}

export function setBadge(count: number) {
  const target = navigator as Navigator & { setAppBadge?: (count: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (!target.setAppBadge) return;
  void (count > 0 ? target.setAppBadge(count) : target.clearAppBadge?.())?.catch(() => undefined);
}
