import { createActivityInDb } from "@/lib/crm/activities";
import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { stripQuoted } from "@/lib/mail/format";

const WINDOW_DAYS = 60;
const BATCH = 100;
const FRESH_MS = 24 * 3_600_000;
const SKIPPED_ROLES = ["drafts", "junk", "outbox"];

type Candidate = {
  message_id: string;
  internet_message_id: string | null;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  from_email: string | null;
  at: Date;
  account: string;
  contact_id: string;
  contact_email: string;
  company_id: string | null;
  direction: "inbound" | "outbound";
  attachments: boolean;
};

function bodyOf(row: Pick<Candidate, "body_text" | "snippet">) {
  const text = row.body_text ? stripQuoted(row.body_text) : "";
  return (text || row.snippet?.trim() || "").slice(0, 4000) || null;
}

export async function fileMailOnTimeline(actor: UserActor, options: { days?: number; limit?: number; now?: number } = {}) {
  const now = options.now ?? Date.now();
  const candidates = await withActor(actor, async (db) => {
    const result = await db.query<Candidate>(
      `with own as (
         select lower(email) as email from crm.mail_sources where user_id = $1
         union select lower($3::text)
       ),
       recent as (
         select m.id, m.internet_message_id, m.subject, m.snippet, m.body_text, m.from_email, m.to_recipients, m.cc_recipients,
           m.has_attachments, s.email as account, coalesce(m.sent_at, m.received_at, m.created_at) as at,
           lower(coalesce(m.from_email, '')) in (select email from own) as mine
         from crm.mail_messages m
         join crm.mail_folders f on f.id = m.folder_id
         join crm.mail_sources s on s.id = m.source_id
         where m.user_id = $1 and not m.is_draft and f.role <> all($4::text[])
           and coalesce(m.sent_at, m.received_at, m.created_at) > to_timestamp($5::double precision / 1000) - make_interval(days => $6)
       ),
       pairs as (
         select r.*, 'inbound' as direction, lower(r.from_email) as address from recent r where not r.mine and r.from_email is not null
         union all
         select r.*, 'outbound' as direction, lower(p->>'address') as address
         from recent r, jsonb_array_elements(coalesce(r.to_recipients, '[]'::jsonb) || coalesce(r.cc_recipients, '[]'::jsonb)) p
         where r.mine
       )
       select distinct on (p.id, c.id)
         p.id as message_id, p.internet_message_id, p.subject, p.snippet, p.body_text, p.from_email, p.at, p.account,
         c.id as contact_id, c.normalized_email as contact_email, c.company_id, p.direction, p.has_attachments as attachments
       from pairs p
       join crm.contacts c on c.workspace_id = $2 and c.archived_at is null and c.normalized_email = p.address
       where p.address not in (select email from own)
         and not exists (
           select 1 from crm.activities a
           where a.workspace_id = $2 and a.contact_id = c.id and a.type = 'email'
             and (
               a.metadata->>'mailMessageId' = p.id::text
               or (p.internet_message_id is not null and a.metadata->>'internetMessageId' = p.internet_message_id)
               or (
                 a.metadata->>'mailMessageId' is null and a.metadata->>'internetMessageId' is null
                 and (a.metadata->>'direction' = 'outbound') = (p.direction = 'outbound')
                 and a.title = left(coalesce(nullif(trim(p.subject), ''), '(no subject)'), 200)
                 and abs(extract(epoch from a.occurred_at - p.at)) < 180
               )
             )
         )
       order by p.id, c.id, p.at desc
       limit $7`,
      [actor.userId, actor.workspaceId, actor.email, SKIPPED_ROLES, now, options.days ?? WINDOW_DAYS, options.limit ?? BATCH],
    );
    return result.rows;
  });
  let filed = 0;
  for (const row of candidates.sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime())) {
    const at = new Date(row.at);
    try {
      await withActor(actor, (db) =>
        createActivityInDb(
          db,
          actor,
          {
            type: "email",
            title: (row.subject?.trim() || "(no subject)").slice(0, 200),
            body: bodyOf(row),
            occurredAt: at.toISOString(),
            companyId: row.company_id,
            contactId: row.contact_id,
            metadata: {
              source: "microsoft",
              direction: row.direction,
              ...(row.direction === "inbound" ? { from: row.contact_email } : { from: row.account, to: row.contact_email }),
              account: row.account,
              mailMessageId: row.message_id,
              ...(row.internet_message_id ? { internetMessageId: row.internet_message_id } : {}),
              ...(row.attachments ? { hasAttachments: true } : {}),
            },
          },
          { operation: "file_mail", source: "microsoft", catchUp: now - at.getTime() > FRESH_MS },
        ),
      );
      filed += 1;
    } catch (error) {
      console.error("Filing an email on the timeline failed", error);
    }
  }
  return { filed };
}
