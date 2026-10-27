import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import type { KnowledgeKind } from "@/lib/knowledge/store";
import { embedTexts } from "@/lib/llm";

const CANDIDATES = 40;
const RRF_K = 60;
const MAX_DISTANCE = 0.75;
const PER_ITEM = 2;

export type KnowledgeScope = "all" | "company" | "eclipse";

export type KnowledgeHit = {
  itemId: string;
  title: string;
  kind: KnowledgeKind;
  scope: "company" | "eclipse";
  companyId: string | null;
  companyName: string | null;
  sourceUrl: string | null;
  position: number;
  offset: number | null;
  text: string;
  score: number;
};

type HitRow = {
  item_id: string;
  title: string;
  kind: KnowledgeKind;
  scope: "company" | "eclipse";
  company_id: string | null;
  company_name: string | null;
  source_url: string | null;
  position: number;
  offset: number | null;
  content: string;
  score: number;
};

export async function searchKnowledge(
  actor: UserActor,
  input: { query: string; scope?: KnowledgeScope; companyId?: string | null; withEclipse?: boolean; limit?: number },
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ hits: KnowledgeHit[]; mode: "hybrid" | "keyword" }> {
  const query = input.query.trim().slice(0, 500);
  if (!query) throw new CrmError("invalid_input", "Say what to look for.", 400, { field: "query" });
  const scope: KnowledgeScope = input.scope ?? (input.companyId ? "company" : "all");
  if (scope === "company" && (!input.companyId || !isUuid(input.companyId))) throw new CrmError("invalid_input", "Choose a company to search.", 400, { field: "companyId" });
  const limit = Math.min(20, Math.max(1, input.limit ?? 8));
  let vector: string | null = null;
  try {
    const [embedding] = await embedTexts([query], { fetchImpl: options.fetchImpl, timeoutMs: 12_000 });
    vector = `[${embedding.join(",")}]`;
  } catch (error) {
    console.error("Knowledge query embedding failed", error);
  }
  return withActor(actor, async (db) => {
    const filter =
      scope === "company"
        ? input.withEclipse
          ? "and ((i.scope = 'company' and i.company_id = $2::uuid) or i.scope = 'eclipse')"
          : "and i.scope = 'company' and i.company_id = $2::uuid"
        : scope === "eclipse"
          ? "and i.scope = 'eclipse' and $2::uuid is null"
          : "and $2::uuid is null";
    const items = await db.query<{ id: string }>(
      `select i.id from crm.knowledge_items i
       where i.workspace_id = $1 and i.archived_at is null and i.status = 'ready' ${filter}`,
      [actor.workspaceId, scope === "company" ? input.companyId : null],
    );
    const ids = items.rows.map((row) => row.id);
    if (ids.length === 0) return { mode: vector ? ("hybrid" as const) : ("keyword" as const), hits: [] };
    if (vector) await db.query("set local hnsw.ef_search = 100; set local hnsw.iterative_scan = relaxed_order");
    const result = await db.query<HitRow>(
      `with nearest as (
         ${
           vector
             ? `select c.id, c.embedding operator(extensions.<=>) $4::extensions.vector as distance
                from crm.knowledge_chunks c
                where c.workspace_id = $1 and c.item_id = any($2::uuid[]) and c.embedding is not null
                order by c.embedding operator(extensions.<=>) $4::extensions.vector
                limit ${CANDIDATES}`
             : "select null::uuid as id, null::float8 as distance where $4::text is null and false"
         }
       ),
       semantic as (
         select id, row_number() over (order by distance) as rank from nearest where distance < ${MAX_DISTANCE}
       ),
       keyword as (
         select c.id, row_number() over (order by ts_rank_cd(c.search, q) desc) as rank
         from crm.knowledge_chunks c, websearch_to_tsquery('english', $3) q
         where c.workspace_id = $1 and c.item_id = any($2::uuid[]) and c.search @@ q
         order by ts_rank_cd(c.search, q) desc
         limit ${CANDIDATES}
       ),
       fused as (
         select id, sum(1.0 / (${RRF_K} + rank)) as score
         from (select id, rank from semantic union all select id, rank from keyword) ranked
         group by id
       ),
       spread as (
         select f.id, f.score, c.item_id, row_number() over (partition by c.item_id order by f.score desc) as place
         from fused f join crm.knowledge_chunks c on c.id = f.id
       )
       select c.item_id, i.title, i.kind, i.scope, i.company_id, co.name as company_name, i.source_url, c.position,
         nullif(strpos(i.content, left(c.content, 80)), 0) - 1 as offset,
         c.content, s.score::float8 as score
       from spread s
       join crm.knowledge_chunks c on c.id = s.id
       join crm.knowledge_items i on i.id = c.item_id and i.status = 'ready' and i.archived_at is null
       left join crm.companies co on co.id = i.company_id
       where s.place <= ${PER_ITEM}
       order by s.score desc, c.position asc
       limit $5`,
      [actor.workspaceId, ids, query, vector, limit],
    );
    return {
      mode: vector ? "hybrid" : "keyword",
      hits: result.rows.map((row) => ({
        itemId: row.item_id,
        title: row.title,
        kind: row.kind,
        scope: row.scope,
        companyId: row.company_id,
        companyName: row.company_name,
        sourceUrl: row.source_url,
        position: row.position,
        offset: row.offset !== null && row.offset >= 0 ? row.offset : null,
        text: row.content,
        score: Math.round(row.score * 10_000) / 10_000,
      })),
    };
  });
}
