import { requireAgent } from "@/lib/api/agent";
import { readJson, withApi } from "@/lib/api/http";
import { listPipeline } from "@/lib/crm/opportunities";
import { savePipelineStages } from "@/lib/crm/pipeline";
import { parseInput, pipelineStagesSchema } from "@/lib/crm/validation";

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    return Response.json({ pipeline: await listPipeline(actor) });
  });
}

export async function PUT(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const parsed = parseInput(pipelineStagesSchema, await readJson(request));
    const stages = await savePipelineStages(actor, parsed.stages);
    return Response.json({ stages });
  });
}
