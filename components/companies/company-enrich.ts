import type { CompanyEnrichment } from "@/lib/enrichment/companies";

export const COMPANY_CHUNK = 5;

type Result = CompanyEnrichment & { companyId: string };

export async function enrichCompaniesRequest(body: Record<string, unknown>) {
  const response = await fetch("/api/enrichment/company", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as
    | { results?: Result[]; result?: CompanyEnrichment; remaining?: number; error?: string }
    | null;
  if (!response.ok || !payload) throw new Error(payload?.error ?? "That lookup failed. Try again.");
  return payload;
}

export async function enrichCompaniesInBatches(ids: string[], progress: (done: number) => void) {
  const results: Result[] = [];
  for (let index = 0; index < ids.length; index += COMPANY_CHUNK) {
    const payload = await enrichCompaniesRequest({ companyIds: ids.slice(index, index + COMPANY_CHUNK) });
    results.push(...(payload.results ?? []));
    progress(results.length);
  }
  return results;
}

export function companyEnrichSummary(results: Result[]) {
  const updated = results.filter((result) => result.status === "updated").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const missing = results.filter((result) => result.status === "not_found").length;
  const failed = results.filter((result) => result.status === "failed");
  const parts = [`Updated ${updated} of ${results.length} ${results.length === 1 ? "company" : "companies"}`];
  if (missing > 0) parts.push(`${missing} not known to context.dev`);
  if (skipped > 0) parts.push(`${skipped} skipped (no website)`);
  if (failed.length > 0) parts.push(`${failed.length} failed: ${failed[0].message}`);
  return { message: parts.join(". "), tone: failed.length > 0 && updated === 0 ? ("error" as const) : ("status" as const) };
}
