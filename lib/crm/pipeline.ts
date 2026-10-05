import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { cleanText } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor, PipelineStage } from "@/lib/crm/types";

export type StageDraft = {
  id?: string;
  name: string;
  probability?: number;
  isWon?: boolean;
  isLost?: boolean;
};

export async function savePipelineStages(actor: Actor, drafts: StageDraft[]): Promise<PipelineStage[]> {
  assertScope(actor.scopes, "opportunities:write");
  if (drafts.length < 2 || drafts.length > 20) {
    throw new CrmError("invalid_input", "A pipeline needs between 2 and 20 stages.", 400);
  }
  const stages = drafts.map((draft, index) => ({
    id: draft.id,
    name: cleanText(draft.name, 80, "name") ?? "",
    probability: clampProbability(draft),
    isWon: Boolean(draft.isWon),
    isLost: Boolean(draft.isLost),
    position: index,
  }));
  if (stages.some((stage) => !stage.name)) {
    throw new CrmError("invalid_input", "Every stage needs a name.", 400, { field: "name" });
  }
  if (stages.filter((stage) => stage.isWon).length !== 1 || stages.filter((stage) => stage.isLost).length !== 1) {
    throw new CrmError("invalid_input", "Mark one stage won and one stage lost.", 400);
  }
  if (stages.some((stage) => stage.isWon && stage.isLost)) {
    throw new CrmError("invalid_input", "A stage cannot be both won and lost.", 400);
  }
  const names = new Set(stages.map((stage) => stage.name.toLowerCase()));
  if (names.size !== stages.length) {
    throw new CrmError("invalid_input", "Stage names must be unique.", 400, { field: "name" });
  }

  return withActor(actor, async (db) => {
    const pipeline = await db.query<{ id: string }>(
      `select id from crm.pipelines
       where workspace_id = $1 and is_default and archived_at is null
       limit 1`,
      [actor.workspaceId],
    );
    const pipelineId = pipeline.rows[0]?.id;
    if (!pipelineId) throw new CrmError("invalid_input", "This workspace has no pipeline.", 400);

    const existing = await db.query<{ id: string }>(
      "select id from crm.pipeline_stages where pipeline_id = $1",
      [pipelineId],
    );
    const existingIds = new Set(existing.rows.map((row) => row.id));
    for (const stage of stages) {
      if (stage.id && !existingIds.has(stage.id)) {
        throw new CrmError("invalid_input", "That stage is not on this pipeline.", 400, { field: "id" });
      }
    }
    const kept = new Set(stages.map((stage) => stage.id).filter(Boolean));
    const removed = [...existingIds].filter((id) => !kept.has(id));
    if (removed.length > 0) {
      const used = await db.query(
        "select 1 from crm.opportunities where stage_id = any($1::uuid[]) limit 1",
        [removed],
      );
      if ((used.rowCount ?? 0) > 0) {
        throw new CrmError(
          "invalid_input",
          "Move opportunities off a stage before removing it.",
          400,
        );
      }
    }

    await db.query(
      `update crm.pipeline_stages
       set position = position + 1000, name = id::text
       where pipeline_id = $1`,
      [pipelineId],
    );
    if (removed.length > 0) {
      await db.query("delete from crm.pipeline_stages where id = any($1::uuid[])", [removed]);
    }

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
          pipelineId,
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
          pipelineId,
          stage.name,
          stage.position,
          stage.probability,
          stage.isWon,
          stage.isLost,
        ],
      );
      saved.push({
        id: inserted.rows[0].id,
        pipelineId,
        name: stage.name,
        position: stage.position,
        probability: stage.probability,
        isWon: stage.isWon,
        isLost: stage.isLost,
      });
    }
    return saved;
  });
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
