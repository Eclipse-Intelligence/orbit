let offered: { run: () => void; until: number } | null = null;

export function offerLinkUndo(run: () => void, ms: number, now = Date.now()) {
  offered = { run, until: now + ms };
}

export function forgetLinkUndo(run: () => void) {
  if (offered?.run === run) offered = null;
}

export function clearLinkUndo() {
  offered = null;
}

export function undoLinkChange(now = Date.now()) {
  const current = offered;
  offered = null;
  if (!current || now > current.until) return false;
  current.run();
  return true;
}
