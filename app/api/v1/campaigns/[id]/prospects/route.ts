import { requireAgent } from "@/lib/api/agent";
import { idempotencyKey, readJson, withApi } from "@/lib/api/http";
import { addProspectsFromApi } from "@/lib/campaigns/agent";
import { PROSPECT_FILTERS, type ProspectFilter } from "@/lib/campaigns/types";
import { listCampaignProspects } from "@/lib/crm/campaigns";
import { CrmError } from "@/lib/crm/errors";
import { campaignProspectsSchema, integerParam, parseInput, takeProvenance } from "@/lib/crm/validation";

type Context = { params: Promise<{ id: string }> };

function filterParam(value: string | null): ProspectFilter | undefined {
  const filter = value?.trim();
  if (!filter) return undefined;
  if ((PROSPECT_FILTERS as readonly string[]).includes(filter)) return filter as ProspectFilter;
  throw new CrmError("invalid_input", `filter is ${PROSPECT_FILTERS.join(", ")}.`, 400, { field: "filter" });
}

export async function GET(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    return Response.json(
      await listCampaignProspects(actor, id, {
        filter: filterParam(params.get("filter")),
        search: params.get("search") ?? undefined,
        page: integerParam(params, "page"),
      }),
    );
  });
}

export async function POST(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { id } = await context.params;
    const parsed = parseInput(campaignProspectsSchema, await readJson(request));
    const { write, provenance } = takeProvenance(parsed, "add_campaign_prospects");
    const result = await addProspectsFromApi(actor, id, write, { idempotencyKey: idempotencyKey(request), provenance });
    return Response.json(result.body, { status: result.status });
  });
}
