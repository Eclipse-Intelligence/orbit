import { redirect } from "next/navigation";
import OpportunitiesScreen from "@/components/crm/opportunities-screen";
import { PAGE_SIZE, pageFromParams, pageOffset } from "@/components/crm/paging";
import { getUserActor } from "@/lib/auth/user";
import { listOpportunities, listPipeline } from "@/lib/crm/opportunities";
import { opportunityQueryFromSearchParams } from "@/lib/crm/validation";
import { proposalsForDeals } from "@/lib/proposals/documents";

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
  const page = pageFromParams(params);
  filters.limit = PAGE_SIZE;
  filters.offset = pageOffset(page);
  const pipeline = await listPipeline(user);
  filters.pipelineId = pipeline.id;
  const listed = await listOpportunities(user, filters);
  const proposals = await proposalsForDeals(user, listed.data.map((item) => ({ id: item.id, companyId: item.companyId })));

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
      proposals={proposals}
      total={listed.total}
      page={page}
      query={filters.query ?? ""}
      stages={pipeline.stages}
      view={params.get("view") === "board" ? "board" : "list"}
    />
  );
}
