const FIRED_KEY = "orbit-task-reminders";
const KEEP_MS = 8 * 24 * 60 * 60 * 1000;

function notificationsSupported() {
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

export function shownAlert<T>(alerts: T[]) {
  return { alert: alerts.at(-1) ?? null, more: Math.max(0, alerts.length - 1) };
}

type Focused = { tagName: string; type?: string; readOnly?: boolean; disabled?: boolean; isContentEditable?: boolean };

export function typingInto(element: Focused | null) {
  if (!element) return false;
  const tag = element.tagName.toUpperCase();
  if (tag === "IFRAME") return true;
  if (tag === "TEXTAREA") return !element.readOnly && !element.disabled;
  if (tag === "INPUT") return !element.readOnly && !element.disabled && !/^(button|checkbox|radio|range|color|file|submit|reset|image|hidden)$/i.test(element.type ?? "text");
  return Boolean(element.isContentEditable);
}

export const KEYBOARD_MIN_PX = 120;

export function keyboardUp(restingHeight: number, height: number, typing: boolean) {
  return typing && restingHeight - height >= KEYBOARD_MIN_PX;
}

export type RestingView = { width: number; height: number };

export function restingView(previous: RestingView, now: RestingView & { layoutHeight: number; typing: boolean }): RestingView {
  if (!now.typing) return { width: now.width, height: now.height };
  if (now.width !== previous.width) return { width: now.width, height: now.layoutHeight };
  return previous;
}

export function alertRenderKey(key: string, hidden: boolean, lastShown: string | null) {
  return hidden && key !== lastShown ? `${key}:waiting` : key;
}
