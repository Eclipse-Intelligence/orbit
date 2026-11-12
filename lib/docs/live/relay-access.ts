import { withActor } from "@/lib/crm/context";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { parseTopic, type LiveEvent } from "@/lib/docs/live/protocol";
import { pageInScope } from "@/lib/docs/store";

export async function relayAllows(actor: UserActor, topic: string, send: boolean) {
  const target = parseTopic(topic);
  if (!target) return false;
  if (target.kind === "person") return !send && target.id === actor.userId;
  if (target.kind === "workspace") return !send && target.id === actor.workspaceId;
  if (!isUuid(target.id)) return false;
  if (target.kind === "draft") {
    const result = await query<{ open: boolean }>("select private.mail_share_open_to($1, $2) as open", [target.id, actor.userId]);
    return result.rows[0]?.open === true;
  }
  if (target.kind === "chat") {
    return withActor(actor, async (db) => {
      const result = await db.query("select 1 from crm.chat_members m where m.conversation_id = $1 and m.user_id = $2", [target.id, actor.userId]);
      return (result.rowCount ?? 0) > 0;
    });
  }
  return withActor(actor, async (db) => {
    const result = await db.query<{ archived: boolean }>(
      `select archived_at is not null as archived from crm.pages p where id = $1 and ${pageInScope("p", 2, 3)}`,
      [target.id, actor.workspaceId, actor.userId],
    );
    const row = result.rows[0];
    return Boolean(row) && !(send && row.archived);
  });
}

export function relayEventAllowed(topic: string, event: LiveEvent) {
  return parseTopic(topic)?.kind === "chat" ? event === "typing" : event !== "typing";
}

export function relayPayload(actor: UserActor, topic: string, event: LiveEvent, payload: unknown) {
  if (event !== "typing") return payload;
  const target = parseTopic(topic);
  const input = payload && typeof payload === "object" ? (payload as { typing?: unknown }) : {};
  return {
    conversationId: target?.id ?? null,
    user: { id: actor.userId, name: actor.fullName?.trim() || actor.email || "A teammate" },
    typing: input.typing === true,
  };
}

export function relayRefusal(topic: string | null, send: boolean) {
  const kind = topic ? parseTopic(topic)?.kind : null;
  if (kind === "draft") return send ? "You can't edit that draft." : "You can't follow that draft.";
  if (kind === "chat") return send ? "You can't type in that conversation." : "You can't follow that conversation.";
  return send ? "You can't edit that note." : "You can't follow that note.";
}
