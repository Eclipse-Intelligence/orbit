import { readJson } from "@/lib/api/http";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { enrichContacts } from "@/lib/enrichment/contacts";
import { enrichmentAllowed } from "@/lib/enrichment/limits";
import { revalidateEnriched } from "@/lib/enrichment/revalidate";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const user = await getUserActor();
  if (!user) return Response.json({ error: "Sign in again." }, { status: 401 });
  const body = (await readJson(request).catch(() => null)) as { ids?: unknown; field?: unknown } | null;
  const field = body?.field;
  if (field !== "email" && field !== "linkedin") return Response.json({ error: "Pick email or LinkedIn." }, { status: 400 });
  const ids = Array.isArray(body?.ids) ? body.ids : [];
  if (!(await enrichmentAllowed(user.userId, ids.length))) {
    return Response.json({ error: "That's a lot of lookups this hour. Try again later." }, { status: 429 });
  }
  try {
    const results = await enrichContacts(user, ids, field);
    if (results.some((result) => result.email || result.linkedinUrl)) revalidateEnriched();
    return Response.json({ results }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof CrmError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Contact enrichment failed", error);
    return Response.json({ error: "Those lookups failed. Try again." }, { status: 500 });
  }
}
