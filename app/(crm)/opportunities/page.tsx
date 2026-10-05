import { redirect } from "next/navigation";
import OpportunitiesScreen from "@/components/crm/opportunities-screen";
import { getUserActor } from "@/lib/auth/user";
import { listCompanies } from "@/lib/crm/companies";
import { listContacts } from "@/lib/crm/contacts";
import { listOpportunities, listPipeline } from "@/lib/crm/opportunities";
import { opportunityQueryFromSearchParams } from "@/lib/crm/validation";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const resolved = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === "string") params.set(key, value);
  }
  const filters = opportunityQueryFromSearchParams(params);
  filters.limit = 100;
  const [listed, companies, contacts, pipeline] = await Promise.all([
    listOpportunities(user, filters),
    listCompanies(user, { limit: 100, sort: "name", order: "asc" }),
    listContacts(user, { limit: 100 }),
    listPipeline(user),
  ]);

  return (
    <OpportunitiesScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      opportunities={listed.data}
      total={listed.total}
      query={filters.query ?? ""}
      companies={companies.data}
      contacts={contacts.data}
      stages={pipeline.stages}
    />
  );
}
