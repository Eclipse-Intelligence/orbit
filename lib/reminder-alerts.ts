const FIRED_KEY = "orbit-task-reminders";
const KEEP_MS = 8 * 24 * 60 * 60 * 1000;

export function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission() {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

export function requestReminderPermission() {
  if (!notificationsSupported() || Notification.permission !== "default") return Promise.resolve(notificationPermission());
  return Notification.requestPermission().catch(() => Notification.permission);
}

export function reminderKey(id: string, dueAt: string, minutes: number) {
  return `${id}:${dueAt}:${minutes}`;
}

function readFired(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(FIRED_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function reminderFired(key: string) {
  return key in readFired();
}

export function markReminderFired(key: string, now = Date.now()) {
  const fired = readFired();
  for (const [entry, at] of Object.entries(fired)) {
    if (typeof at !== "number" || now - at > KEEP_MS) delete fired[entry];
  }
  fired[key] = now;
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify(fired));
  } catch {}
}
