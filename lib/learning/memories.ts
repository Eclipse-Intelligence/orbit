import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";

export const MEMORY_SCOPES = ["personal", "business", "market"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type Confidence = "low" | "medium" | "high";
export type MemorySource = { label: string; url?: string };

export const MEMORY_LIMITS = { title: 160, body: 1200, kind: 40, sources: 10, sourceLabel: 200, sourceUrl: 1000 } as const;

export type Memory = {
  id: string;
  scope: MemoryScope;
  kind: string;
  title: string;
  body: string;
  sources: MemorySource[];
  confidence: Confidence;
  pinned: boolean;
  companyId: string | null;
  origin: "learning" | "assistant" | "manual";
  observedAt: string;
  updatedAt: string;
};

type Row = {
  id: string;
  scope: MemoryScope;
  kind: string;
  title: string;
  body: string;
  sources: MemorySource[];
  confidence: Confidence;
  pinned: boolean;
  company_id: string | null;
  origin: Memory["origin"];
  observed_at: Date;
  updated_at: Date;
};

const COLUMNS = "id, scope, kind, title, body, sources, confidence, pinned, company_id, origin, observed_at, updated_at";

function mapMemory(row: Row): Memory {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    title: row.title,
    body: row.body,
    sources: Array.isArray(row.sources) ? row.sources : [],
    confidence: row.confidence,
    pinned: row.pinned,
    companyId: row.company_id,
    origin: row.origin,
    observedAt: row.observed_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function clip(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function cleanSources(value: unknown): MemorySource[] {
  if (!Array.isArray(value)) return [];
  const out: MemorySource[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const label = clip((item as { label?: unknown }).label, MEMORY_LIMITS.sourceLabel);
    const rawUrl = clip((item as { url?: unknown }).url, MEMORY_LIMITS.sourceUrl);
    const url = /^(https?:\/\/|\/)/.test(rawUrl) ? rawUrl : undefined;
    if (!label && !url) continue;
    out.push(url ? { label: label || url, url } : { label });
    if (out.length >= MEMORY_LIMITS.sources) break;
  }
  return out;
}

export type MemoryDraft = {
  kind: string;
  title: string;
  body: string;
  sources?: unknown;
  confidence?: Confidence;
  companyId?: string | null;
  pinned?: boolean;
};

function cleanDraft(draft: MemoryDraft) {
  const title = clip(draft.title, MEMORY_LIMITS.title);
  const body = typeof draft.body === "string" ? draft.body.trim().slice(0, MEMORY_LIMITS.body) : "";
  if (!title || !body) throw new CrmError("invalid_input", "A memory needs a title and some text.", 400, { field: !title ? "title" : "body" });
  const kind = clip(draft.kind, MEMORY_LIMITS.kind).toLowerCase().replace(/[^a-z_ ]/g, "").replace(/\s+/g, "_") || "note";
  const confidence: Confidence = draft.confidence === "low" || draft.confidence === "high" ? draft.confidence : "medium";
  return { title, body, kind, confidence, sources: cleanSources(draft.sources), companyId: draft.companyId ?? null, pinned: draft.pinned === true };
}

export async function insertMemory(db: Db, actor: UserActor, scope: MemoryScope, draft: MemoryDraft, origin: Memory["origin"]) {
  const clean = cleanDraft(draft);
  const result = await db.query<Row>(
    `insert into crm.memories (workspace_id, user_id, scope, kind, title, body, sources, confidence, pinned, company_id, origin)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11) returning ${COLUMNS}`,
    [actor.workspaceId, scope === "personal" ? actor.userId : null, scope, clean.kind, clean.title, clean.body, JSON.stringify(clean.sources), clean.confidence, clean.pinned, clean.companyId, origin],
  );
  return mapMemory(result.rows[0]);
}

export async function reviseMemory(db: Db, id: string, patch: { title?: string; body?: string; confidence?: Confidence; sources?: unknown; pinned?: boolean }) {
  const current = await db.query<Row>(`select ${COLUMNS} from crm.memories where id = $1 and archived_at is null`, [id]);
  if (!current.rows[0]) throw new CrmError("not_found", "That memory doesn't exist or was forgotten.", 404);
  const row = mapMemory(current.rows[0]);
  const title = patch.title === undefined ? row.title : clip(patch.title, MEMORY_LIMITS.title);
  const body = patch.body === undefined ? row.body : patch.body.trim().slice(0, MEMORY_LIMITS.body);
  if (!title || !body) throw new CrmError("invalid_input", "A memory needs a title and some text.", 400);
  const sources = patch.sources === undefined ? row.sources : [...cleanSources(patch.sources), ...row.sources].slice(0, MEMORY_LIMITS.sources);
  const result = await db.query<Row>(
    `update crm.memories set title = $2, body = $3, confidence = $4, sources = $5::jsonb, pinned = $6, observed_at = case when $7 then now() else observed_at end
     where id = $1 returning ${COLUMNS}`,
    [id, title, body, patch.confidence ?? row.confidence, JSON.stringify(sources), patch.pinned ?? row.pinned, patch.body !== undefined || patch.title !== undefined],
  );
  return mapMemory(result.rows[0]);
}

export async function listMemories(
  actor: UserActor,
  options: { scope?: MemoryScope; query?: string; limit?: number; since?: string } = {},
): Promise<Memory[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const query = options.query?.trim();
  return withActor(actor, async (db) => {
    const result = await db.query<Row>(
      `select ${COLUMNS} from crm.memories
       where archived_at is null and workspace_id = $1
         and ($2::text is null or scope = $2)
         and ($3::text is null or search @@ websearch_to_tsquery('english', $3) or title ilike '%' || $3 || '%')
         and ($5::timestamptz is null or updated_at >= $5)
       order by pinned desc, ${query ? "ts_rank(search, websearch_to_tsquery('english', $3)) desc," : ""} updated_at desc
       limit $4`,
      [actor.workspaceId, options.scope ?? null, query || null, limit, options.since ?? null],
    );
    return result.rows.map(mapMemory);
  });
}

export async function rememberNote(
  actor: UserActor,
  input: { title?: unknown; body?: unknown; kind?: unknown; shared?: unknown; sources?: unknown },
  origin: "assistant" | "manual" = "assistant",
) {
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) throw new CrmError("invalid_input", "Say what to remember.", 400, { field: "body" });
  const words = body.split(/\s+/);
  const title = typeof input.title === "string" && input.title.trim() ? input.title : words.length > 10 ? `${words.slice(0, 10).join(" ")}…` : body;
  return withActor(actor, (db) =>
    insertMemory(db, actor, input.shared === true ? "business" : "personal", { kind: typeof input.kind === "string" ? input.kind : "note", title, body, sources: input.sources, confidence: "high" }, origin),
  );
}

export async function updateMemory(actor: UserActor, id: string, patch: { title?: unknown; body?: unknown; pinned?: unknown }) {
  return withActor(actor, (db) =>
    reviseMemory(db, id, {
      title: typeof patch.title === "string" ? patch.title : undefined,
      body: typeof patch.body === "string" ? patch.body : undefined,
      pinned: typeof patch.pinned === "boolean" ? patch.pinned : undefined,
    }),
  );
}

export async function forgetMemory(actor: UserActor, id: string) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ title: string }>("update crm.memories set archived_at = now() where id = $1 and archived_at is null returning title", [id]);
    if (!result.rows[0]) throw new CrmError("not_found", "That memory doesn't exist or was already forgotten.", 404);
    return { forgotten: result.rows[0].title };
  });
}

function age(iso: string, now: number) {
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function line(memory: Memory, now: number) {
  return `- ${memory.pinned ? "(pinned) " : ""}${memory.title}: ${memory.body.replace(/\s+/g, " ").slice(0, 400)} [${memory.kind}, ${memory.confidence} confidence, ${age(memory.updatedAt, now)}]`;
}

export async function memoryBriefing(actor: UserActor, options: { now?: Date; brief?: string | null } = {}) {
  const now = (options.now ?? new Date()).getTime();
  const [personal, business, market] = await Promise.all([
    listMemories(actor, { scope: "personal", limit: 20 }),
    listMemories(actor, { scope: "business", limit: 20 }),
    listMemories(actor, { scope: "market", limit: 12, since: new Date(now - 21 * 86_400_000).toISOString() }),
  ]);
  if (!personal.length && !business.length && !market.length && !options.brief) return "";
  const block = (title: string, items: Memory[]) => (items.length ? `\n\n## ${title}\n${items.map((item) => line(item, now)).join("\n")}` : "");
  const brief = options.brief ? `\n\n## This morning's brief\n${options.brief.slice(0, 2_500)}` : "";
  return `\n\n# What Orbit has learned
Orbit learns every night from the user's conversations, edits and decisions, from the business's deals, calls and replies, and from market notes. These are the most relevant notes. They can be out of date or wrong: prefer fresh data from the tools when they disagree, mention the note when it shapes your answer, and use recall to search everything learned, with sources. When the user corrects you or states a lasting preference, offer to remember it.${block("About the user and how they like to work", personal)}${block("The business: customers, ICP, objections, what works", business)}${block("The market, last three weeks", market)}${brief}`;
}

export async function recall(actor: UserActor, query: string, limit = 12) {
  const text = query.trim();
  if (!text) throw new CrmError("invalid_input", "Say what to look for.", 400, { field: "query" });
  const [memories, notes] = await Promise.all([
    listMemories(actor, { query: text, limit }),
    withActor(actor, async (db) =>
      (
        await db.query<{ id: string; kind: string; headline: string; summary: string | null; url: string | null; about: string | null; published_at: Date | null; created_at: Date }>(
          `select id, kind, headline, summary, url, about, published_at, created_at from crm.market_notes
           where workspace_id = $1 and to_tsvector('english', headline || ' ' || coalesce(summary, '') || ' ' || coalesce(about, '')) @@ websearch_to_tsquery('english', $2)
           order by coalesce(published_at, created_at) desc limit $3`,
          [actor.workspaceId, text, limit],
        )
      ).rows,
    ),
  ]);
  return {
    memories: memories.map((memory) => ({ ...memory, mine: memory.scope === "personal" })),
    marketNotes: notes.map((note) => ({
      id: note.id,
      kind: note.kind,
      headline: note.headline,
      summary: note.summary,
      url: note.url,
      about: note.about,
      date: (note.published_at ?? note.created_at).toISOString(),
    })),
  };
}
