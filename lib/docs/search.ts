import { withActor } from "@/lib/crm/context";
import { iso } from "@/lib/crm/mutate";
import type { Actor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { excerptFrom } from "@/lib/docs/markdown";
import { assertDocsRead, pagingNumber, visibilityOf } from "@/lib/docs/store";
import type { DocKind, DocSearchHit } from "@/lib/docs/types";

const SEARCH_LIMIT_MAX = 50;

let trigramSchema: string | null = null;

async function trigram(db: Db) {
  if (trigramSchema) return trigramSchema;
  const result = await db.query<{ schema: string }>(
    "select n.nspname as schema from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm'",
  );
  const schema = result.rows[0]?.schema ?? "public";
  trigramSchema = /^[a-z_][a-z0-9_]*$/.test(schema) ? schema : "public";
  return trigramSchema;
}

export function prefixQuery(text: string) {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
  return words.length ? words.map((word) => `${word}:*`).join(" & ") : null;
}

function likePattern(text: string) {
  return text.toLowerCase().replace(/[\\%_]/g, (match) => `\\${match}`);
}

type HitRow = {
  id: string;
  kind: DocKind;
  title: string;
  daily_date: string | null;
  folder_id: string | null;
  shared: boolean;
  effective_shared: boolean;
  user_id: string | null;
  edited_at: Date;
  title_match: "exact" | "prefix" | "contains" | "fuzzy" | null;
  body: boolean;
  score: number;
  snippet: string | null;
  head: string;
};

export async function searchDocs(
  actor: Actor,
  query: string,
  options: { limit?: number; daily?: boolean; folderId?: string } = {},
): Promise<DocSearchHit[]> {
  assertDocsRead(actor);
  const text = query.replace(/\s+/g, " ").trim().slice(0, 200);
  const limit = pagingNumber(options.limit, 20, 1, SEARCH_LIMIT_MAX);
  const kinds = options.daily === false ? ["note"] : ["note", "daily"];
  return withActor(actor, async (db) => {
    if (!text) {
      const recent = await db.query<HitRow>(
        `select p.id, p.kind, p.title, p.daily_date::text as daily_date, p.folder_id, p.shared, p.effective_shared, p.user_id, p.edited_at,
           null as title_match, false as body, 0 as score, null as snippet, left(p.content, 400) as head
         from crm.pages p where p.workspace_id = $1 and p.archived_at is null and p.kind = any($2::text[])
         order by p.edited_at desc limit $3`,
        [actor.workspaceId, kinds, limit],
      );
      return recent.rows.map((row) => hit(actor, row));
    }
    const schema = await trigram(db);
    const result = await db.query<HitRow>(
      `with q as (
         select $2::text as raw, lower($2::text) as low, $3::text as pattern,
           case when $4::text is null then null else to_tsquery('english', $4::text) end as ts
       ),
       found as (
         select p.id, p.kind, p.title, p.daily_date::text as daily_date, p.folder_id, p.shared, p.effective_shared, p.user_id, p.edited_at, p.content,
           lower(p.title) = q.low as exact,
           lower(p.title) like q.pattern || '%' escape '\\' as prefix,
           lower(p.title) like '%' || q.pattern || '%' escape '\\' as contains,
           greatest(${schema}.similarity(p.title, q.raw), ${schema}.word_similarity(q.raw, p.title)) as fuzzy,
           coalesce(q.ts is not null and p.search @@ q.ts, false) as body,
           case when q.ts is null then 0 else ts_rank(p.search, q.ts) end as rank,
           q.ts
         from crm.pages p, q
         where p.workspace_id = $1 and p.archived_at is null and p.kind = any($5::text[])
           and ($6::uuid is null or p.folder_id = $6)
           and (
             p.title ilike '%' || q.pattern || '%' escape '\\'
             or p.title operator(${schema}.%) q.raw
             or q.raw operator(${schema}.<%) p.title
             or (q.ts is not null and p.search @@ q.ts)
           )
       ),
       ranked as (
         select *,
           (case when exact then 100 when prefix then 60 when contains then 35 else 0 end) + fuzzy * 40 + rank * 30 + (case when body then 10 else 0 end) as score
         from found
         order by score desc, edited_at desc
         limit $7
       )
       select id, kind, title, daily_date, folder_id, shared, effective_shared, user_id, edited_at,
         case when exact then 'exact' when prefix then 'prefix' when contains then 'contains' when fuzzy >= 0.3 then 'fuzzy' else null end as title_match,
         body, score::float8 as score,
         case when body then ts_headline('english', left(content, 50000), ts, 'MaxWords=24, MinWords=10, MaxFragments=1, StartSel="", StopSel=""') end as snippet,
         left(content, 400) as head
       from ranked order by score desc, edited_at desc`,
      [actor.workspaceId, text, likePattern(text), prefixQuery(text), kinds, options.folderId ?? null, limit],
    );
    return result.rows.map((row) => hit(actor, row));
  });
}

function hit(actor: Actor, row: HitRow): DocSearchHit {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    dailyDate: row.daily_date,
    folderId: row.folder_id,
    visibility: visibilityOf(row.shared, row.effective_shared),
    ownedByMe: actor.type === "user" && row.user_id === actor.userId,
    editedAt: iso(row.edited_at)!,
    titleMatch: row.title_match,
    snippet: row.snippet ? row.snippet.replace(/\s+/g, " ").trim() : row.head ? excerptFrom(row.head, 160) : null,
    score: Number(row.score),
  };
}
