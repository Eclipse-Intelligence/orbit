import { SYNC_ORIGIN_HEADER, syncOrigin } from "@/lib/sync-origin";
import type { CaptureAction, CaptureOutcome } from "@/lib/crm/capture-actions";

export const OFFLINE = "That didn't save. Check your connection and try again.";
export const SAVE_FAILED = "That didn't save. Try again.";

const MOVE_RETRY_MS = [1_000, 3_000, 8_000, 20_000, 45_000, 60_000, 60_000];

export async function postCapture(action: CaptureAction, workspaceId: string, keepalive = false) {
  let response: Response;
  try {
    response = await fetch("/api/capture", {
      method: "POST",
      headers: { "content-type": "application/json", [SYNC_ORIGIN_HEADER]: syncOrigin() },
      body: JSON.stringify({ ...action, captureWorkspaceId: workspaceId }),
      keepalive,
    });
  } catch {
    throw new Error(OFFLINE);
  }
  const body = (await response.json().catch(() => ({}))) as Partial<CaptureOutcome> & { error?: string };
  if (!response.ok) throw Object.assign(new Error(body.error ?? SAVE_FAILED), { status: response.status });
  return body;
}

function transient(error: unknown) {
  const status = error instanceof Error && "status" in error ? Number(error.status) : null;
  return status === null || status === 429 || status >= 500;
}

export async function postCaptureKeeping(action: CaptureAction, workspaceId: string, keepalive = false) {
  const retries = action.kind === "reply-done" || action.kind === "reply-snooze" ? MOVE_RETRY_MS : [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await postCapture(action, workspaceId, keepalive);
    } catch (error) {
      if (attempt >= retries.length || !transient(error)) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, retries[attempt]));
    }
  }
}
