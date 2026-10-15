import { unstable_isUnrecognizedActionError } from "next/navigation";

const RELOAD_KEY = "stale-deploy-reload";
const RELOAD_GAP_MS = 30_000;

export function reloadIfStaleDeploy(error: unknown) {
  if (typeof window === "undefined" || !unstable_isUnrecognizedActionError(error)) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY));
    if (Number.isFinite(last) && Date.now() - last < RELOAD_GAP_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {}
  window.location.reload();
  return true;
}
