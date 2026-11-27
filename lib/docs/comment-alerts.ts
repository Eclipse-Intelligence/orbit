import { after } from "next/server";
import { withActor } from "@/lib/crm/context";
import { memberActor } from "@/lib/crm/conversations";
import { isUuid } from "@/lib/crm/mutate";
import { commentHref } from "@/lib/docs/comment-params";
import { query } from "@/lib/db/pool";
import { pushToUser, type PushSender } from "@/lib/push";
import { notify } from "@/lib/workflows/engine";

type Target = {
  page_id: string;
  title: string;
  workspace_id: string;
  workspace_name: string;
  user_id: string;
  role: "owner" | "admin" | "member";
  email: string | null;
  full_name: string | null;
  author_name: string;
  body: string;
  is_reply: boolean;
};

export async function alertDocOwner(commentId: string, push?: PushSender) {
  if (!isUuid(commentId)) return false;
  const found = await query<Target>("select * from private.comment_alert_target($1)", [commentId]);
  const target = found.rows[0];
  if (!target) return false;
  const owner = memberActor(target);
  const key = `doc-comment:${commentId}`;
  const fresh = await withActor(owner, async (db) => {
    const result = await db.query("insert into crm.push_log (workspace_id, user_id, key) values ($1, $2, $3) on conflict (user_id, key) do nothing returning id", [owner.workspaceId, owner.userId, key]);
    return (result.rowCount ?? 0) > 0;
  });
  if (!fresh) return false;
  const title = `${target.author_name} ${target.is_reply ? "replied on" : "commented on"} ${target.title.trim() || "Untitled"}`.slice(0, 200);
  const body = target.body.trim().slice(0, 240);
  const href = commentHref(target.page_id, commentId);
  await notify(owner, owner.userId, { title, body, href, source: "doc_comment" }).catch(() => undefined);
  await pushToUser(owner, { title, body, url: href, tag: key }, { send: push }).catch((error) => console.error("Doc comment push failed", error));
  return true;
}

export async function scheduleDocAlert(commentId: string, push?: PushSender) {
  const run = () => alertDocOwner(commentId, push).catch((error) => console.error("Doc comment alert failed", error));
  try {
    after(run);
  } catch {
    await run();
  }
}
