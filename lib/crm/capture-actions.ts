import { snoozeTask } from "@/lib/crm/action-needed";
import { createContactFromMeeting, hideAttendee } from "@/lib/crm/calendar";
import { moveImport } from "@/lib/crm/call-routing";
import { createContactAndFile, fileImport, ignoreImport } from "@/lib/crm/conversations";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { closeFollowUp } from "@/lib/crm/follow-ups";
import { isUuid } from "@/lib/crm/mutate";
import { completeTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { applyMailAction } from "@/lib/mail/actions";
import { createAndFileUnknown, fileUnknownTo, ignoreUnknownMail, moveUnknownMail, neverAskUnknownMail, showUnknownMail } from "@/lib/mail/filing";
import { removeSenderRule } from "@/lib/mail/capture-filter";
import { updatePrepared } from "@/lib/mail/prepare";
import { dismissReply, finishReminder } from "@/lib/mail/waiting";
import { decideApproval } from "@/lib/workflows/store";
import { workspaceActors } from "@/lib/crm/workspaces";

export type CaptureAction =
  | { kind: "approve"; runId: string }
  | { kind: "reject"; runId: string; note: string | null }
  | { kind: "nudge-dismiss"; id: string }
  | { kind: "call-dismiss"; id: string }
  | { kind: "reminder-done"; id: string }
  | { kind: "reply-done"; thread: string }
  | { kind: "reply-snooze"; thread: string; until: string }
  | { kind: "reply-dismiss"; thread: string; at: string }
  | { kind: "task-done"; id: string }
  | { kind: "task-snooze"; id: string; until: string }
  | { kind: "email-create"; key: string }
  | { kind: "email-file"; key: string; contactId: string }
  | { kind: "email-move"; key: string; workspaceId: string }
  | { kind: "email-ignore"; key: string }
  | { kind: "email-never"; key: string }
  | { kind: "email-show"; key: string }
  | { kind: "rule-remove"; sender: string }
  | { kind: "import-create"; id: string; email: string }
  | { kind: "import-file"; id: string; contactId: string }
  | { kind: "import-ignore"; id: string }
  | { kind: "import-move"; id: string; workspaceId: string }
  | { kind: "person-create"; email: string }
  | { kind: "person-hide"; email: string };

export type CaptureOutcome = { ok: true; contactId?: string; contactName?: string | null; taskId?: string; importId?: string; relink?: boolean };

function text(value: unknown, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function invalid(): never {
  throw new CrmError("invalid_input", "Capture didn't understand that change. Reload and try again.", 400);
}

function id(value: unknown) {
  const found = text(value, 100);
  if (!isUuid(found)) invalid();
  return found;
}

function required(value: unknown, max = 500) {
  const found = text(value, max);
  if (!found) invalid();
  return found;
}

export function readCaptureAction(body: unknown): CaptureAction {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  switch (input.kind) {
    case "approve":
      return { kind: "approve", runId: id(input.runId) };
    case "reject":
      return { kind: "reject", runId: id(input.runId), note: text(input.note, 1000) || null };
    case "nudge-dismiss":
    case "call-dismiss":
    case "reminder-done":
    case "task-done":
    case "import-ignore":
      return { kind: input.kind, id: id(input.id) };
    case "reply-done":
      return { kind: "reply-done", thread: required(input.thread) };
    case "reply-snooze":
      return { kind: "reply-snooze", thread: required(input.thread), until: required(input.until, 40) };
    case "reply-dismiss":
      return { kind: "reply-dismiss", thread: required(input.thread), at: required(input.at, 40) };
    case "task-snooze":
      return { kind: "task-snooze", id: id(input.id), until: required(input.until, 40) };
    case "email-create":
    case "email-ignore":
    case "email-never":
    case "email-show":
      return { kind: input.kind, key: required(input.key) };
    case "rule-remove":
      return { kind: "rule-remove", sender: required(input.sender, 320) };
    case "email-file":
      return { kind: "email-file", key: required(input.key), contactId: id(input.contactId) };
    case "email-move":
      return { kind: "email-move", key: required(input.key), workspaceId: id(input.workspaceId) };
    case "import-create":
      return { kind: "import-create", id: id(input.id), email: required(input.email, 320) };
    case "import-file":
      return { kind: "import-file", id: id(input.id), contactId: id(input.contactId) };
    case "import-move":
      return { kind: "import-move", id: id(input.id), workspaceId: id(input.workspaceId) };
    case "person-create":
    case "person-hide":
      return { kind: input.kind, email: required(input.email, 320) };
    default:
      return invalid();
  }
}

export async function captureActor(signedIn: UserActor, workspaceId: unknown) {
  if (workspaceId === undefined || workspaceId === null || workspaceId === signedIn.workspaceId) return signedIn;
  const found = typeof workspaceId === "string" && isUuid(workspaceId) ? (await workspaceActors(signedIn)).find((item) => item.workspaceId === workspaceId) : undefined;
  if (!found) throw new CrmError("conflict", "You're no longer in that workspace. Reload Capture.", 409);
  return found;
}

async function approvalActor(actor: UserActor, runId: string) {
  const run = await withActor(actor, async (db) => {
    const result = await db.query<{ workspace_id: string }>("select workspace_id from crm.workflow_runs where id = $1 and owner_id = $2", [runId, actor.userId]);
    return result.rows[0] ?? null;
  });
  if (!run || run.workspace_id === actor.workspaceId) return actor;
  return (await workspaceActors(actor)).find((item) => item.workspaceId === run.workspace_id) ?? actor;
}

export async function runCaptureAction(actor: UserActor, action: CaptureAction, options: { fetchImpl?: typeof fetch } = {}): Promise<CaptureOutcome> {
  switch (action.kind) {
    case "approve":
      await decideApproval(await approvalActor(actor, action.runId), action.runId, { approved: true }, options);
      return { ok: true };
    case "reject":
      await decideApproval(await approvalActor(actor, action.runId), action.runId, { approved: false, note: action.note }, options);
      return { ok: true };
    case "nudge-dismiss":
      await updatePrepared(actor, action.id, "dismiss");
      return { ok: true };
    case "call-dismiss":
      await closeFollowUp(actor, action.id, "dismissed");
      return { ok: true };
    case "reminder-done":
      await finishReminder(actor, action.id);
      return { ok: true };
    case "reply-done":
      await applyMailAction(actor, { thread: action.thread, action: "archive", view: { role: "inbox" } }, options.fetchImpl);
      return { ok: true };
    case "reply-snooze":
      await applyMailAction(actor, { thread: action.thread, action: "snooze", view: { role: "inbox" }, until: action.until }, options.fetchImpl);
      return { ok: true };
    case "reply-dismiss":
      await dismissReply(actor, action.thread, action.at);
      return { ok: true };
    case "task-done":
      await completeTask(actor, action.id, { provenance: { operation: "complete_task", source: "web" } });
      return { ok: true, taskId: action.id };
    case "task-snooze":
      await snoozeTask(actor, action.id, action.until);
      return { ok: true, taskId: action.id };
    case "email-create": {
      const filed = await createAndFileUnknown(actor, action.key);
      return { ok: true, contactId: filed.contactId, contactName: filed.contactName };
    }
    case "email-file": {
      const filed = await fileUnknownTo(actor, action.key, action.contactId);
      return { ok: true, contactId: filed.contactId, contactName: filed.contactName };
    }
    case "email-move":
      await moveUnknownMail(actor, action.key, action.workspaceId);
      return { ok: true };
    case "email-ignore":
      await ignoreUnknownMail(actor, action.key);
      return { ok: true };
    case "email-never":
      await neverAskUnknownMail(actor, action.key);
      return { ok: true };
    case "email-show":
      await showUnknownMail(actor, action.key);
      return { ok: true };
    case "rule-remove":
      await removeSenderRule(actor, action.sender);
      return { ok: true };
    case "import-create": {
      const filed = await createContactAndFile(actor, action.id, action.email, { summarise: false });
      return { ok: true, contactId: filed.contactId, contactName: filed.contactName, importId: action.id, relink: true };
    }
    case "import-file":
      await fileImport(actor, action.id, action.contactId, { summarise: false });
      return { ok: true, importId: action.id };
    case "import-ignore":
      await ignoreImport(actor, action.id);
      return { ok: true };
    case "import-move":
      await moveImport(actor, action.id, action.workspaceId);
      return { ok: true };
    case "person-create": {
      const created = await createContactFromMeeting(actor, action.email);
      return { ok: true, contactId: created.contactId, contactName: created.contactName };
    }
    case "person-hide":
      await hideAttendee(actor, action.email);
      return { ok: true };
  }
}
