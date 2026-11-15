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

export function linkUndoOffered(run: () => void, now = Date.now()) {
  return offered?.run === run && now <= offered.until;
}

export function linkUndoPending(now = Date.now()) {
  return Boolean(offered && now <= offered.until);
}

const claims = new Set<{ blocked: () => boolean }>();

export function claimUndoKey(blocked: () => boolean = () => false) {
  const claim = { blocked };
  claims.add(claim);
  return () => {
    claims.delete(claim);
  };
}

function zListening() {
  for (const claim of claims) if (!claim.blocked()) return true;
  return false;
}

export type UndoToast = { kind: "link"; run: () => void } | { kind: "done"; id: string } | { kind: "reopen" };

export function zUndoes(toast: UndoToast, newestDone: string | null, now = Date.now()) {
  if (toast.kind === "reopen" || !zListening()) return false;
  if (toast.kind === "link") return linkUndoOffered(toast.run, now);
  return !linkUndoPending(now) && newestDone === toast.id;
}
