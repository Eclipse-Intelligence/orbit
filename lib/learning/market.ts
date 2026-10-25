import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { assertScope, hasScope } from "@/lib/crm/scopes";
import type { Actor, UserActor } from "@/lib/crm/types";

export const WATCH_KINDS = ["topic", "competitor", "person", "account", "source"] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

export const NOTE_KINDS = ["news", "post", "launch", "hire", "funding", "signal", "research", "other"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const MARKET_NOTES_PER_CALL = 50;

export type WatchItem = { id: string; kind: WatchKind; label: string; url: string | null; notes: string | null; companyId: string | null; createdAt: string };

export type MarketNote = {
  id: string;
  kind: NoteKind;
  headline: string;
  summary: string | null;
  url: string | null;
  about: string | null;
  publishedAt: string | null;
  companyId: string | null;
  from: string | null;
  processedAt: string | null;
  createdAt: string;
};

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function link(value: unknown, max: number) {
  const typed = text(value, max + 1);
  if (!typed) return null;
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed.replace(/^\/+/, "")}`;
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) && raw.length <= max ? url.href : null;
  } catch {
    return null;
  }
}

function canReadWatchlist(actor: Actor) {
  if (actor.type === "agent" && !hasScope(actor.scopes, "crm:read")) assertScope(actor.scopes, "market:write");
}

export async function listWatchlist(actor: Actor): Promise<WatchItem[]> {
  canReadWatchlist(actor);
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; kind: WatchKind; label: string; url: string | null; notes: string | null; company_id: string | null; created_at: Date }>(
      "select id, kind, label, url, notes, company_id, created_at from crm.watchlist where workspace_id = $1 order by kind, lower(label)",
      [actor.workspaceId],
    );
    return result.rows.map((row) => ({ id: row.id, kind: row.kind, label: row.label, url: row.url, notes: row.notes, companyId: row.company_id, createdAt: row.created_at.toISOString() }));
  });
}

export async function addWatchItems(actor: UserActor, items: unknown) {
  if (!Array.isArray(items) || items.length === 0) throw new CrmError("invalid_input", "Add at least one thing to watch.", 400, { field: "label" });
  if (items.length > 50) throw new CrmError("invalid_input", "Add up to 50 at a time.", 400);
  const clean = items.map((item) => {
    const raw = (item ?? {}) as Record<string, unknown>;
    const kind = WATCH_KINDS.includes(raw.kind as WatchKind) ? (raw.kind as WatchKind) : null;
    const label = text(raw.label, 160);
    if (!kind) throw new CrmError("invalid_input", "Choose topic, competitor, person, account or source.", 400, { field: "kind" });
    if (!label) throw new CrmError("invalid_input", "Give it a name.", 400, { field: "label" });
    const url = raw.url ? link(raw.url, 500) : null;
    if (raw.url && !url) throw new CrmError("invalid_input", "Enter a full link starting with https://.", 400, { field: "url" });
    return { kind, label, url, notes: text(raw.notes, 500) || null, companyId: typeof raw.companyId === "string" ? raw.companyId : null };
  });
  return withActor(actor, async (db) => {
    const added: WatchItem[] = [];
    for (const item of clean) {
      const result = await db.query<{ id: string; created_at: Date }>(
        `insert into crm.watchlist (workspace_id, kind, label, url, notes, company_id, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (workspace_id, kind, lower(label)) do update set url = coalesce(excluded.url, crm.watchlist.url), notes = coalesce(excluded.notes, crm.watchlist.notes)
         returning id, created_at`,
        [actor.workspaceId, item.kind, item.label, item.url, item.notes, item.companyId, actor.userId],
      );
      added.push({ id: result.rows[0].id, kind: item.kind, label: item.label, url: item.url, notes: item.notes, companyId: item.companyId, createdAt: result.rows[0].created_at.toISOString() });
    }
    return added;
  });
}

export async function removeWatchItems(actor: UserActor, ids: unknown) {
  const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  if (!list.length) throw new CrmError("invalid_input", "Choose what to stop watching.", 400);
  return withActor(actor, async (db) => {
    const result = await db.query<{ label: string }>("delete from crm.watchlist where workspace_id = $1 and id = any($2::uuid[]) returning label", [actor.workspaceId, list]);
    return { removed: result.rows.map((row) => row.label) };
  });
}

export async function addMarketNotes(actor: Actor, notes: unknown) {
  if (actor.type === "agent") assertScope(actor.scopes, "market:write");
  if (!Array.isArray(notes) || notes.length === 0) throw new CrmError("invalid_input", "Send at least one note.", 400, { field: "notes" });
  if (notes.length > MARKET_NOTES_PER_CALL) throw new CrmError("invalid_input", `Send up to ${MARKET_NOTES_PER_CALL} notes at a time.`, 400, { field: "notes" });
  const rejected: { index: number; reason: string }[] = [];
  const clean = notes.flatMap((note, index) => {
    const raw = (note ?? {}) as Record<string, unknown>;
    const headline = text(raw.headline, 300);
    if (!headline) {
      rejected.push({ index, reason: "headline is missing" });
      return [];
    }
    const url = raw.url ? link(raw.url, 1000) : null;
    if (raw.url && !url) {
      rejected.push({ index, reason: "url isn't a full http(s) link" });
      return [];
    }
    const published = typeof raw.publishedAt === "string" && !Number.isNaN(Date.parse(raw.publishedAt)) ? new Date(raw.publishedAt).toISOString() : null;
    return [
      {
        kind: NOTE_KINDS.includes(raw.kind as NoteKind) ? (raw.kind as NoteKind) : "news",
        headline,
        summary: typeof raw.summary === "string" ? raw.summary.trim().slice(0, 2000) || null : null,
        url,
        about: text(raw.about, 200) || null,
        published,
      },
    ];
  });
  return withActor(actor, async (db) => {
    let added = 0;
    let duplicates = 0;
    for (const note of clean) {
      const result = await db.query(
        `insert into crm.market_notes (workspace_id, kind, headline, summary, url, about, published_at, agent_id, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (workspace_id, url) where url is not null do nothing`,
        [
          actor.workspaceId,
          note.kind,
          note.headline,
          note.summary,
          note.url,
          note.about,
          note.published,
          actor.type === "agent" ? actor.agentId : null,
          actor.type === "user" ? actor.userId : null,
        ],
      );
      if (result.rowCount) added += 1;
      else duplicates += 1;
    }
    return { added, duplicates, rejected };
  });
}

type NoteRow = {
  id: string;
  kind: NoteKind;
  headline: string;
  summary: string | null;
  url: string | null;
  about: string | null;
  published_at: Date | null;
  company_id: string | null;
  agent_name: string | null;
  user_name: string | null;
  processed_at: Date | null;
  created_at: Date;
};

export function mapNote(row: NoteRow): MarketNote {
  return {
    id: row.id,
    kind: row.kind,
    headline: row.headline,
    summary: row.summary,
    url: row.url,
    about: row.about,
    publishedAt: row.published_at?.toISOString() ?? null,
    companyId: row.company_id,
    from: row.agent_name ?? row.user_name,
    processedAt: row.processed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export const NOTE_SELECT = `select n.id, n.kind, n.headline, n.summary, n.url, n.about, n.published_at, n.company_id, a.name as agent_name, p.full_name as user_name, n.processed_at, n.created_at
  from crm.market_notes n left join crm.agents a on a.id = n.agent_id left join crm.profiles p on p.id = n.created_by_user_id`;

export async function listMarketNotes(actor: UserActor, options: { limit?: number; since?: string } = {}) {
  return withActor(actor, async (db) => {
    const result = await db.query<NoteRow>(
      `${NOTE_SELECT} where n.workspace_id = $1 and ($2::timestamptz is null or n.created_at >= $2) order by n.created_at desc limit $3`,
      [actor.workspaceId, options.since ?? null, Math.min(Math.max(options.limit ?? 50, 1), 200)],
    );
    return result.rows.map(mapNote);
  });
}

export async function deleteMarketNote(actor: UserActor, id: string) {
  return withActor(actor, async (db) => {
    const result = await db.query("delete from crm.market_notes where workspace_id = $1 and id = $2", [actor.workspaceId, id]);
    if (!result.rowCount) throw new CrmError("not_found", "That note doesn't exist.", 404);
    return { deleted: true };
  });
}
