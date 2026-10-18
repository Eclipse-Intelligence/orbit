import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { cleanText } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import { isUuid } from "@/lib/crm/mutate";
import type { Actor, BoardKind, PipelineStage } from "@/lib/crm/types";

export type StageDraft = {
  id?: string;
  name: string;
  probability?: number;
  isWon?: boolean;
  isLost?: boolean;
};

export async function savePipelineStages(
  actor: Actor,
  drafts: StageDraft[],
  pipelineId: string | null = null,
): Promise<PipelineStage[]> {
  assertScope(actor.scopes, "opportunities:write");
  if (pipelineId !== null && !isUuid(pipelineId)) throw new CrmError("not_found", "Board not found.", 404);
  return withActor(actor, async (db) => {
    const pipeline = await db.query<{ id: string; kind: BoardKind }>(
      `select id, kind from crm.pipelines
       where workspace_id = $1 and archived_at is null
         and (case when $2::uuid is null then is_default else id = $2::uuid end)
       limit 1`,
      [actor.workspaceId, pipelineId],
    );
    const found = pipeline.rows[0];
    if (!found) {
      if (pipelineId) throw new CrmError("not_found", "Board not found.", 404);
      throw new CrmError("invalid_input", "This workspace has no pipeline.", 400);
    }
    const board = found.kind === "board";
    const stages = cleanStages(drafts, board);
    const id = found.id;

    const existing = await db.query<{ id: string }>(
      "select id from crm.pipeline_stages where pipeline_id = $1",
      [id],
    );
    const existingIds = new Set(existing.rows.map((row) => row.id));
    for (const stage of stages) {
      if (stage.id && !existingIds.has(stage.id)) {
        throw new CrmError("invalid_input", board ? "That stage is not on this board." : "That stage is not on this pipeline.", 400, { field: "id" });
      }
    }
    const kept = new Set(stages.map((stage) => stage.id).filter(Boolean));
    const removed = [...existingIds].filter((stageId) => !kept.has(stageId));
    if (removed.length > 0) {
      const used = await db.query(
        "select 1 from crm.opportunities where stage_id = any($1::uuid[]) and archived_at is null limit 1",
        [removed],
      );
      if ((used.rowCount ?? 0) > 0) {
        throw new CrmError(
          "invalid_input",
          board ? "Move cards off a stage before removing it." : "Move opportunities off a stage before removing it.",
          400,
        );
      }
    }

    await db.query(
      `update crm.pipeline_stages
       set position = position + 1000, name = id::text
       where pipeline_id = $1`,
      [id],
    );
    const saved: PipelineStage[] = [];
    for (const stage of stages) {
      if (stage.id) {
        await db.query(
          `update crm.pipeline_stages
           set name = $2, position = $3, probability = $4, is_won = $5, is_lost = $6
           where id = $1`,
          [stage.id, stage.name, stage.position, stage.probability, stage.isWon, stage.isLost],
        );
        saved.push({
          id: stage.id,
          pipelineId: id,
          name: stage.name,
          position: stage.position,
          probability: stage.probability,
          isWon: stage.isWon,
          isLost: stage.isLost,
        });
        continue;
      }
      const inserted = await db.query<{ id: string }>(
        `insert into crm.pipeline_stages (
          workspace_id, pipeline_id, name, position, probability, is_won, is_lost
        ) values ($1, $2, $3, $4, $5, $6, $7)
        returning id`,
        [
          actor.workspaceId,
          id,
          stage.name,
          stage.position,
          stage.probability,
          stage.isWon,
          stage.isLost,
        ],
      );
      saved.push({
        id: inserted.rows[0].id,
        pipelineId: id,
        name: stage.name,
        position: stage.position,
        probability: stage.probability,
        isWon: stage.isWon,
        isLost: stage.isLost,
      });
    }

    if (removed.length > 0) {
      const open = saved.find((stage) => !stage.isWon && !stage.isLost) ?? saved[0];
      const won = saved.find((stage) => stage.isWon) ?? open;
      const lost = saved.find((stage) => stage.isLost) ?? open;
      await db.query(
        `update crm.opportunities
         set stage_id = case status when 'won' then $2::uuid when 'lost' then $3::uuid else $4::uuid end,
             pipeline_id = $5
         where stage_id = any($1::uuid[]) and archived_at is not null`,
        [removed, won.id, lost.id, open.id, id],
      );
      await db.query("delete from crm.pipeline_stages where id = any($1::uuid[])", [removed]);
    }
    await db.query(
      `update crm.opportunities o
       set status = next.status
       from (
         select id, case when is_won then 'won' when is_lost then 'lost' else 'open' end as status
         from crm.pipeline_stages
         where pipeline_id = $1
       ) next
       where o.stage_id = next.id and o.status <> next.status`,
      [id],
    );
    return saved;
  });
}

function cleanStages(drafts: StageDraft[], board: boolean) {
  const noun = board ? "A board" : "A pipeline";
  const least = board ? 1 : 2;
  if (drafts.length < least || drafts.length > 20) {
    throw new CrmError("invalid_input", `${noun} needs between ${least} and 20 stages.`, 400);
  }
  const stages = drafts.map((draft, index) => ({
    id: draft.id,
    name: cleanText(draft.name, 80, "name") ?? "",
    probability: board ? 0 : clampProbability(draft),
    isWon: board ? false : Boolean(draft.isWon),
    isLost: board ? false : Boolean(draft.isLost),
    position: index,
  }));
  if (stages.some((stage) => !stage.name)) {
    throw new CrmError("invalid_input", "Every stage needs a name.", 400, { field: "name" });
  }
  if (!board && (stages.filter((stage) => stage.isWon).length !== 1 || stages.filter((stage) => stage.isLost).length !== 1)) {
    throw new CrmError("invalid_input", "Mark one stage won and one stage lost.", 400);
  }
  if (stages.some((stage) => stage.isWon && stage.isLost)) {
    throw new CrmError("invalid_input", "A stage cannot be both won and lost.", 400);
  }
  const names = new Set(stages.map((stage) => stage.name.toLowerCase()));
  if (names.size !== stages.length) {
    throw new CrmError("invalid_input", "Stage names must be unique.", 400, { field: "name" });
  }
  return stages;
}

function clampProbability(draft: StageDraft) {
  if (draft.isWon) return 100;
  if (draft.isLost) return 0;
  const value = draft.probability ?? 10;
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new CrmError("invalid_input", "Probability is a whole number from 0 to 100.", 400, {
      field: "probability",
    });
  }
  return value;
}
