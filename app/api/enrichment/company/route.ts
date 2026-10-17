import { readJson } from "@/lib/api/http";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { backfillCompanies, enrichCompanies, enrichCompany } from "@/lib/enrichment/companies";
import { enrichmentAllowed } from "@/lib/enrichment/limits";
import { revalidateEnriched } from "@/lib/enrichment/revalidate";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const user = await getUserActor();
  if (!user) return Response.json({ error: "Sign in again." }, { status: 401 });
  const body = (await readJson(request).catch(() => null)) as { companyId?: unknown; companyIds?: unknown; backfill?: unknown } | null;
  const cost = Array.isArray(body?.companyIds) ? body.companyIds.length : body?.backfill === true ? 5 : 1;
  if (!(await enrichmentAllowed(user.userId, cost))) {
    return Response.json({ error: "That's a lot of lookups this hour. Try again later." }, { status: 429 });
  }
  try {
    if (body?.backfill === true) {
      if (user.role !== "owner" && user.role !== "admin") {
        return Response.json({ error: "Only workspace owners and admins can fill in every company." }, { status: 403 });
      }
      const outcome = await backfillCompanies(user);
      if (outcome.results.some((result) => result.status === "updated")) revalidateEnriched();
      return Response.json(outcome, { headers: { "cache-control": "no-store" } });
    }
    if (Array.isArray(body?.companyIds)) {
      const results = await enrichCompanies(user, body.companyIds);
      if (results.some((result) => result.status === "updated")) revalidateEnriched();
      return Response.json({ results }, { headers: { "cache-control": "no-store" } });
    }
    if (typeof body?.companyId !== "string") return Response.json({ error: "Pick a company." }, { status: 400 });
    const result = await enrichCompany(user, body.companyId);
    if (result.status === "updated") revalidateEnriched();
    return Response.json({ result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Company enrichment failed", error);
    return Response.json({ error: "That lookup failed. Try again." }, { status: 500 });
  }
}
