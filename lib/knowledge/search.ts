import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import type { KnowledgeKind } from "@/lib/knowledge/store";
import { embedTexts } from "@/lib/llm";

const CANDIDATES = 40;
const RRF_K = 60;
const MAX_DISTANCE = 0.75;

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
          ? "and ((i.scope = 'company' and i.company_id = $3::uuid) or i.scope = 'eclipse')"
          : "and i.scope = 'company' and i.company_id = $3::uuid"
        : scope === "eclipse"
          ? "and i.scope = 'eclipse'"
          : "and $3::uuid is null";
    const base = `from crm.knowledge_chunks c join crm.knowledge_items i on i.id = c.item_id
      where c.workspace_id = $1 and i.workspace_id = $1 and i.archived_at is null and i.status = 'ready' ${filter}`;
    if (vector) await db.query("set local hnsw.ef_search = 100; set local hnsw.iterative_scan = relaxed_order");
    const result = await db.query<HitRow>(
      `with semantic as (
         ${
           vector
             ? `select c.id, row_number() over (order by c.embedding operator(extensions.<=>) $4::extensions.vector) as rank
                ${base} and c.embedding is not null and c.embedding operator(extensions.<=>) $4::extensions.vector < ${MAX_DISTANCE}
                order by c.embedding operator(extensions.<=>) $4::extensions.vector
                limit ${CANDIDATES}`
             : "select null::uuid as id, null::bigint as rank where $4::text is null and false"
         }
       ),
       keyword as (
         select c.id, row_number() over (order by ts_rank_cd(c.search, q) desc) as rank
         ${base.replace("where", ", websearch_to_tsquery('english', $2) q where")} and c.search @@ q
         order by ts_rank_cd(c.search, q) desc
         limit ${CANDIDATES}
       ),
       fused as (
         select id, sum(1.0 / (${RRF_K} + rank)) as score
         from (select id, rank from semantic union all select id, rank from keyword) ranked
         group by id
       )
       select c.item_id, i.title, i.kind, i.scope, i.company_id, co.name as company_name, i.source_url, c.position,
         nullif(strpos(i.content, left(c.content, 80)), 0) - 1 as offset,
         c.content, f.score::float8 as score
       from fused f
       join crm.knowledge_chunks c on c.id = f.id
       join crm.knowledge_items i on i.id = c.item_id
       left join crm.companies co on co.id = i.company_id
       order by f.score desc, c.position asc
       limit $5`,
      [actor.workspaceId, query, scope === "company" ? input.companyId : null, vector, limit],
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
