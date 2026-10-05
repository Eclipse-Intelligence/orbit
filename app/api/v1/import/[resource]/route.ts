import { requireAgent } from "@/lib/api/agent";
import { withApi } from "@/lib/api/http";
import { CrmError } from "@/lib/crm/errors";
import { importCompaniesCsv, importContactsCsv } from "@/lib/crm/spreadsheet";

export async function POST(request: Request, context: { params: Promise<{ resource: string }> }) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    const { resource } = await context.params;
    const type = request.headers.get("content-type") ?? "";
    const csv = type.includes("application/json")
      ? stringField(await request.json(), "csv")
      : await request.text();
    if (resource === "companies") return Response.json(await importCompaniesCsv(actor, csv));
    if (resource === "contacts") return Response.json(await importContactsCsv(actor, csv));
    throw new CrmError("not_found", "That import is not available.", 404);
  });
}

function stringField(value: unknown, key: string) {
  if (!value || typeof value !== "object" || !(key in value)) {
    throw new CrmError("invalid_input", "Send the CSV as text or as { csv }.", 400);
  }
  const csv = (value as Record<string, unknown>)[key];
  if (typeof csv !== "string" || !csv.trim()) {
    throw new CrmError("invalid_input", "Send the CSV as text or as { csv }.", 400);
  }
  return csv;
}
