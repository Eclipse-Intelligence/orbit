import { redirect } from "next/navigation";
import ActivitiesScreen from "@/components/crm/activities-screen";
import { PAGE_SIZE, pageFromParams, pageOffset } from "@/components/crm/paging";
import { getUserActor } from "@/lib/auth/user";
import { listActivities } from "@/lib/crm/activities";
import { activityQueryFromSearchParams } from "@/lib/crm/validation";

export const dynamic = "force-dynamic";

export default async function ActivitiesPage({
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
  const filters = activityQueryFromSearchParams(params);
  const page = pageFromParams(params);
  filters.limit = PAGE_SIZE;
  filters.offset = pageOffset(page);
  const listed = await listActivities(user, filters);

  return (
    <ActivitiesScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      activities={listed.data}
      total={listed.total}
      page={page}
      query={filters.query ?? ""}
    />
  );
}
