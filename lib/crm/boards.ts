import type { Db } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid, lockNamespace, recordAudit } from "@/lib/crm/mutate";
import { cleanText } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor, Board, BoardKind, BoardSummary, PipelineStage } from "@/lib/crm/types";

export const BOARD_STARTER_STAGES = ["To start", "In progress", "Done"];

type BoardRow = {
  id: string;
  name: string;
  kind: BoardKind;
  add_on_won: boolean;
  position: number;
  count: number;
};

function mapBoard(row: BoardRow): BoardSummary {
  return { id: row.id, name: row.name, kind: row.kind, addOnWon: row.add_on_won, position: row.position, count: row.count };
}

function boardName(value: unknown) {
  const name = cleanText(typeof value === "string" ? value : "", 120, "name");
  if (!name) throw new CrmError("invalid_input", "Give the board a name.", 400, { field: "name" });
  return name;
}

async function readBoard(db: Db, workspaceId: string, id: string) {
  if (!isUuid(id)) return null;
  const result = await db.query<BoardRow>(
    `select p.id, p.name, p.kind, p.add_on_won, p.position,
       (select count(*)::int from crm.opportunities o where o.pipeline_id = p.id and o.archived_at is null) as count
     from crm.pipelines p
     where p.id = $1 and p.workspace_id = $2 and p.archived_at is null and p.kind = 'board'`,
    [id, workspaceId],
  );
  return result.rows[0] ?? null;
}

async function assertUniqueName(db: Db, workspaceId: string, name: string, except: string | null) {
  const clash = await db.query(
    `select 1 from crm.pipelines
     where workspace_id = $1 and archived_at is null and kind = 'board'
       and lower(name) = lower($2) and ($3::uuid is null or id <> $3::uuid)
     limit 1`,
    [workspaceId, name, except],
  );
  if ((clash.rowCount ?? 0) > 0) {
    throw new CrmError("conflict", `There's already a board called ${name}.`, 409, { field: "name" });
  }
}

export async function listBoards(actor: Actor): Promise<BoardSummary[]> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const result = await db.query<BoardRow>(
      `select p.id, p.name, p.kind, p.add_on_won, p.position,
         (select count(*)::int from crm.opportunities o where o.pipeline_id = p.id and o.archived_at is null) as count
       from crm.pipelines p
       where p.workspace_id = $1 and p.archived_at is null and p.kind = 'board'
       order by p.position asc, p.created_at asc`,
      [actor.workspaceId],
    );
    return result.rows.map(mapBoard);
  });
}

export async function getBoard(actor: Actor, id: string): Promise<Board> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const row = await readBoard(db, actor.workspaceId, id);
    if (!row) throw new CrmError("not_found", "Board not found.", 404);
    const stages = await db.query<{ id: string; pipeline_id: string; name: string; position: number; probability: number; is_won: boolean; is_lost: boolean }>(
      `select id, pipeline_id, name, position, probability, is_won, is_lost
       from crm.pipeline_stages where pipeline_id = $1 order by position asc`,
      [row.id],
    );
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      addOnWon: row.add_on_won,
      position: row.position,
      stages: stages.rows.map(
        (stage): PipelineStage => ({
          id: stage.id,
          pipelineId: stage.pipeline_id,
          name: stage.name,
          position: stage.position,
          probability: stage.probability,
          isWon: stage.is_won,
          isLost: stage.is_lost,
        }),
      ),
    };
  });
}

export async function createBoard(actor: Actor, input: { name: unknown }): Promise<BoardSummary> {
  assertScope(actor.scopes, "opportunities:write");
  const name = boardName(input.name);
  return withActor(actor, async (db) => {
    await lockNamespace(db, actor.workspaceId, "boards");
    await assertUniqueName(db, actor.workspaceId, name, null);
    const count = await db.query<{ total: number }>(
      "select count(*)::int as total from crm.pipelines where workspace_id = $1 and archived_at is null and kind = 'board'",
      [actor.workspaceId],
    );
    if ((count.rows[0]?.total ?? 0) >= 30) throw new CrmError("invalid_input", "You can have up to 30 boards.", 400);
    const inserted = await db.query<{ id: string }>(
      `insert into crm.pipelines (workspace_id, name, is_default, kind, position)
       values ($1, $2, false, 'board',
         (select coalesce(max(position) + 1, 0) from crm.pipelines where workspace_id = $1 and kind = 'board'))
       returning id`,
      [actor.workspaceId, name],
    );
    const id = inserted.rows[0].id;
    for (const [position, stage] of BOARD_STARTER_STAGES.entries()) {
      await db.query(
        `insert into crm.pipeline_stages (workspace_id, pipeline_id, name, position, probability)
         values ($1, $2, $3, $4, 0)`,
        [actor.workspaceId, id, stage, position],
      );
    }
    await recordAudit(db, actor, "board.created", "pipeline", id, { operation: "create_board" }, { after: { name } });
    const row = await readBoard(db, actor.workspaceId, id);
    if (!row) throw new CrmError("internal_error", "Board was not saved.", 500);
    return mapBoard(row);
  });
}

export async function updateBoard(
  actor: Actor,
  id: string,
  input: { name?: unknown; addOnWon?: unknown },
): Promise<BoardSummary> {
  assertScope(actor.scopes, "opportunities:write");
  return withActor(actor, async (db) => {
    const current = await readBoard(db, actor.workspaceId, id);
    if (!current) throw new CrmError("not_found", "Board not found.", 404);
    const sets: string[] = [];
    const values: unknown[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = boardName(input.name);
      if (name !== current.name) {
        await assertUniqueName(db, actor.workspaceId, name, current.id);
        values.push(name);
        sets.push(`name = $${values.length}`);
        before.name = current.name;
        after.name = name;
      }
    }
    if (input.addOnWon !== undefined) {
      const addOnWon = input.addOnWon === true;
      if (addOnWon !== current.add_on_won) {
        values.push(addOnWon);
        sets.push(`add_on_won = $${values.length}`);
        before.addOnWon = current.add_on_won;
        after.addOnWon = addOnWon;
      }
    }
    if (sets.length === 0) return mapBoard(current);
    values.push(current.id);
    await db.query(`update crm.pipelines set ${sets.join(", ")} where id = $${values.length}`, values);
    await recordAudit(db, actor, "board.updated", "pipeline", current.id, { operation: "update_board" }, {
      fields: Object.keys(after),
      before,
      after,
    });
    const row = await readBoard(db, actor.workspaceId, current.id);
    if (!row) throw new CrmError("not_found", "Board not found.", 404);
    return mapBoard(row);
  });
}

export async function archiveBoard(actor: Actor, id: string): Promise<{ archived: number }> {
  assertScope(actor.scopes, "opportunities:write");
  return withActor(actor, async (db) => {
    const current = await readBoard(db, actor.workspaceId, id);
    if (!current) throw new CrmError("not_found", "Board not found.", 404);
    const cards = await db.query(
      "update crm.opportunities set archived_at = now() where pipeline_id = $1 and archived_at is null",
      [current.id],
    );
    await db.query("update crm.pipelines set archived_at = now() where id = $1", [current.id]);
    await recordAudit(db, actor, "board.archived", "pipeline", current.id, { operation: "archive_board" }, {
      before: { name: current.name, cards: current.count },
      after: { archivedAt: new Date().toISOString() },
    });
    return { archived: cards.rowCount ?? 0 };
  });
}
