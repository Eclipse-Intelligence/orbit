export function pushTrail(step: string, data: Record<string, unknown> = {}) {
  try {
    const body = JSON.stringify({ step, data: { ...data, at: new Date().toISOString(), visible: document.visibilityState } });
    if (navigator.sendBeacon?.("/api/push/trail", new Blob([body], { type: "application/json" }))) return;
    void fetch("/api/push/trail", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
  } catch {}
}
