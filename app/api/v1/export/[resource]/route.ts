import { requireAgent } from "@/lib/api/agent";
import { withApi } from "@/lib/api/http";
import { CrmError } from "@/lib/crm/errors";
import {
  exportActivitiesCsv,
  exportCompaniesCsv,
  exportContactsCsv,
  exportOpportunitiesCsv,
  exportTasksCsv,
} from "@/lib/crm/spreadsheet";
import { toCsv } from "@/lib/csv";

const exporters = {
  companies: exportCompaniesCsv,
  contacts: exportContactsCsv,
  opportunities: exportOpportunitiesCsv,
  activities: exportActivitiesCsv,
  tasks: exportTasksCsv,
} as const;

export async function GET(request: Request, context: { params: Promise<{ resource: string }> }) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { resource } = await context.params;
    const exportRows = exporters[resource as keyof typeof exporters];
    if (!exportRows) throw new CrmError("not_found", "That export is not available.", 404);
    const csv = toCsv(await exportRows(actor));
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${resource}.csv"`,
      },
    });
  });
}
