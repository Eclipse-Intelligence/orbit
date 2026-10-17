import { readJson } from "@/lib/api/http";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { enrichCompany } from "@/lib/enrichment/companies";
import { enrichmentAllowed } from "@/lib/enrichment/limits";
import { revalidateEnriched } from "@/lib/enrichment/revalidate";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const user = await getUserActor();
  if (!user) return Response.json({ error: "Sign in again." }, { status: 401 });
  const body = (await readJson(request).catch(() => null)) as { companyId?: unknown } | null;
  if (typeof body?.companyId !== "string") return Response.json({ error: "Pick a company." }, { status: 400 });
  if (!(await enrichmentAllowed(user.userId, 1))) {
    return Response.json({ error: "That's a lot of lookups this hour. Try again later." }, { status: 429 });
  }
  try {
    const result = await enrichCompany(user, body.companyId);
    if (result.status === "updated") revalidateEnriched();
    return Response.json({ result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Company enrichment failed", error);
    return Response.json({ error: "That lookup failed. Try again." }, { status: 500 });
  }
}
