import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { CONTENT_MAX } from "@/lib/knowledge/indexing";
import { addKnowledgeText } from "@/lib/knowledge/store";

function dateLabel(value: Date) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" }).format(value);
}

export async function addCallToKnowledge(actor: UserActor, insightId: string) {
  const call = await withActor(actor, async (db) => {
    const result = await db.query<{
      title: string | null;
      type: string;
      occurred_at: Date;
      company_id: string | null;
      contact_name: string | null;
      summary: string | null;
      transcript: string | null;
    }>(
      `select a.title, a.type, a.occurred_at, coalesce(i.company_id, a.company_id, ct.company_id) as company_id,
         nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), '') as contact_name, i.summary, i.transcript
       from crm.call_insights i
       join crm.activities a on a.id = i.activity_id
       left join crm.contacts ct on ct.id = coalesce(i.contact_id, a.contact_id)
       where i.id = $1 and i.workspace_id = $2 and i.status = 'ready' and a.archived_at is null`,
      [insightId, actor.workspaceId],
    );
    return result.rows[0] ?? null;
  });
  if (!call?.company_id || !call.transcript?.trim()) return null;
  const when = dateLabel(call.occurred_at);
  const kind = call.type === "meeting" ? "Meeting" : "Call";
  const intro = [`${kind}${call.contact_name ? ` with ${call.contact_name}` : ""} on ${when}.`, call.summary ? `Summary:\n${call.summary}` : null].filter(Boolean).join("\n\n");
  return addKnowledgeText(
    actor,
    { companyId: call.company_id },
    {
      kind: "transcript",
      title: `${call.title?.trim() || kind} · ${when}`.slice(0, 300),
      content: `${intro}\n\nTranscript:\n${call.transcript}`.slice(0, CONTENT_MAX),
      sourceRef: `call:${insightId}`,
    },
    { operation: "index_call_transcript" },
  );
}

export async function backfillCalls(actor: UserActor, companyId: string, limit = 25) {
  const pending = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string }>(
      `with activity as (
         select a.id from crm.activities a where a.workspace_id = $1 and a.company_id = $2
         union
         select a.id from crm.activities a join crm.contacts ct on ct.id = a.contact_id where a.workspace_id = $1 and ct.company_id = $2
       )
       select i.id from crm.call_insights i
       join crm.activities a on a.id = i.activity_id
       where i.workspace_id = $1 and i.status = 'ready' and a.archived_at is null and (i.company_id = $2 or i.activity_id in (select id from activity))
         and not exists (select 1 from crm.knowledge_items k where k.workspace_id = $1 and k.source_ref = 'call:' || i.id::text)
       order by a.occurred_at desc
       limit $3`,
      [actor.workspaceId, companyId, limit],
    );
    return result.rows.map((row) => row.id);
  });
  const added: string[] = [];
  for (const id of pending) {
    const outcome = await addCallToKnowledge(actor, id).catch((error) => {
      console.error("Call backfill failed", error);
      return null;
    });
    if (outcome?.created) added.push(outcome.item.id);
  }
  return added;
}
