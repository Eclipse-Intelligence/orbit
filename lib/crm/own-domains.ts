import type { Db } from "@/lib/db/pool";

export async function ownDomainsInDb(db: Db, workspaceId: string, userId?: string | null) {
  const result = await db.query<{ domain: string }>(
    `select distinct d.domain
     from crm.workspace_brands b
     cross join lateral unnest(b.own_domains) as d(domain)
     where b.workspace_id = $1
        or b.workspace_id in (select m.workspace_id from crm.workspace_members m where m.user_id = $2)`,
    [workspaceId, userId ?? null],
  );
  return new Set(result.rows.map((row) => row.domain));
}
