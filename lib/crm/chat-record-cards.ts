import { companyHref, contactHref, dealHref } from "@/lib/crm/hrefs";
import { taskPanelHref } from "@/lib/chat/discussions";
import { RECORD_CARDS_MAX, RECORD_CARD_KINDS, type ChatRecordCard, type RecordCardKind, type RecordRef } from "@/lib/chat/links";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { pageHref } from "@/lib/docs/routes";

function capitalised(value: string | null) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : null;
}

function money(value: string | null, currency: string) {
  const amount = Number(value);
  if (value === null || !Number.isFinite(amount)) return null;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${value}`;
  }
}

function card(kind: RecordCardKind, id: string, href: string, fields: Partial<Omit<ChatRecordCard, "kind" | "id" | "href">> & { title: string }): ChatRecordCard {
  return { kind, id, href, subtitle: null, pill: null, figure: null, dueAt: null, ...fields };
}

type Reader = (db: Db, id: string) => Promise<ChatRecordCard | null>;

const READERS: Record<RecordCardKind, Reader> = {
  company: async (db, id) => {
    const result = await db.query<{ name: string; lifecycle: string; domain: string | null; industry: string | null }>(
      "select name, lifecycle, domain, industry from crm.companies where id = $1 and archived_at is null",
      [id],
    );
    const row = result.rows[0];
    return row ? card("company", id, companyHref(id), { title: row.name, subtitle: row.domain ?? row.industry, pill: capitalised(row.lifecycle) }) : null;
  },
  contact: async (db, id) => {
    const result = await db.query<{ first_name: string | null; last_name: string | null; email: string | null; job_title: string | null; company_name: string | null }>(
      `select ct.first_name, ct.last_name, ct.email, ct.job_title, co.name as company_name
       from crm.contacts ct left join crm.companies co on co.id = ct.company_id
       where ct.id = $1 and ct.archived_at is null`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || row.email || "Unnamed contact";
    const subtitle = [row.job_title, row.company_name].filter(Boolean).join(" at ") || (row.email && row.email !== name ? row.email : null);
    return card("contact", id, contactHref(id), { title: name, subtitle });
  },
  opportunity: async (db, id) => {
    const result = await db.query<{ name: string; value: string | null; currency: string; stage: string | null; company_name: string }>(
      `select o.name, o.value::text as value, o.currency, ps.name as stage, co.name as company_name
       from crm.opportunities o
       join crm.companies co on co.id = o.company_id
       left join crm.pipeline_stages ps on ps.id = o.stage_id
       where o.id = $1 and o.archived_at is null`,
      [id],
    );
    const row = result.rows[0];
    return row ? card("opportunity", id, dealHref(id), { title: row.name, subtitle: row.company_name, pill: row.stage, figure: money(row.value, row.currency) }) : null;
  },
  task: async (db, id) => {
    const result = await db.query<{ title: string; due_at: Date | string | null; completed_at: Date | string | null }>(
      "select title, due_at, completed_at from crm.tasks where id = $1 and archived_at is null",
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return card("task", id, taskPanelHref(id), {
      title: row.title,
      pill: row.completed_at ? "Done" : null,
      dueAt: row.due_at && !row.completed_at ? new Date(row.due_at).toISOString() : null,
    });
  },
  doc: async (db, id) => {
    const result = await db.query<{ title: string; kind: string; daily_date: string | null }>(
      "select title, kind, to_char(daily_date, 'YYYY-MM-DD') as daily_date from crm.pages where id = $1 and archived_at is null",
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    const title = row.title.trim() || (row.daily_date ? `Daily note ${row.daily_date}` : "Untitled");
    return card("doc", id, pageHref(id), { title });
  },
};

export function cleanRecordRefs(input: unknown): RecordRef[] {
  const list = Array.isArray(input) ? input : [];
  if (list.length > RECORD_CARDS_MAX) throw new CrmError("invalid_input", `Ask for up to ${RECORD_CARDS_MAX} records at a time.`, 400);
  const seen = new Set<string>();
  const refs: RecordRef[] = [];
  for (const item of list) {
    const [kind, id] = typeof item === "string" ? item.split(":") : [];
    if (!RECORD_CARD_KINDS.includes(kind as RecordCardKind) || !id || !isUuid(id)) throw new CrmError("invalid_input", "That isn't a record Orbit can show.", 400);
    const key = `${kind}:${id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind: kind as RecordCardKind, id: id.toLowerCase() });
  }
  return refs;
}

export async function listRecordCards(actor: UserActor, refs: RecordRef[]): Promise<ChatRecordCard[]> {
  if (refs.length === 0) return [];
  const cards = await withActor(actor, async (db) => {
    const found: (ChatRecordCard | null)[] = [];
    for (const ref of refs) found.push(await READERS[ref.kind](db, ref.id));
    return found;
  });
  return cards.filter((item): item is ChatRecordCard => item !== null);
}
