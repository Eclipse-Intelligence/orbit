let offered: { run: () => void; until: number } | null = null;

export function offerLinkUndo(run: () => void, ms: number) {
  offered = { run, until: Date.now() + ms };
}

export function forgetLinkUndo(run: () => void) {
  if (offered?.run === run) offered = null;
}

export function undoLinkChange() {
  const current = offered;
  offered = null;
  if (!current || Date.now() > current.until) return false;
  current.run();
  return true;
}
