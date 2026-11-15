let offered: { run: () => void; until: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

function set(next: typeof offered) {
  if (offered?.timer) clearTimeout(offered.timer);
  offered = next;
  changed();
}

export function offerLinkUndo(run: () => void, ms: number, now = Date.now()) {
  const timer = typeof window === "undefined" ? null : setTimeout(() => forgetLinkUndo(run), ms);
  set({ run, until: now + ms, timer });
}

export function forgetLinkUndo(run: () => void) {
  if (offered?.run === run) set(null);
}

export function clearLinkUndo() {
  if (offered) set(null);
}

export function undoLinkChange(now = Date.now()) {
  const current = offered;
  if (current) set(null);
  if (!current || now > current.until) return false;
  current.run();
  return true;
}

export function linkUndoOffered(run: () => void, now = Date.now()) {
  return offered?.run === run && now <= offered.until;
}

export function linkUndoPending(now = Date.now()) {
  return Boolean(offered && now <= offered.until);
}

export function watchLinkUndo(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function linkUndoVersion() {
  return version;
}
