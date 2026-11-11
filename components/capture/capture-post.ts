import type { CaptureAction, CaptureOutcome } from "@/lib/crm/capture-actions";

export const OFFLINE = "That didn't save. Check your connection and try again.";
export const SAVE_FAILED = "That didn't save. Try again.";

export async function postCapture(action: CaptureAction, workspaceId: string, keepalive = false) {
  let response: Response;
  try {
    response = await fetch("/api/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...action, captureWorkspaceId: workspaceId }),
      keepalive,
    });
  } catch {
    throw new Error(OFFLINE);
  }
  const body = (await response.json().catch(() => ({}))) as Partial<CaptureOutcome> & { error?: string };
  if (!response.ok) throw new Error(body.error ?? SAVE_FAILED);
  return body;
}
