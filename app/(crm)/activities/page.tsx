import { redirect } from "next/navigation";
import ActivitiesScreen from "@/components/crm/activities-screen";
import { getUserActor } from "@/lib/auth/user";
import { listActivities } from "@/lib/crm/activities";
import { listCompanies } from "@/lib/crm/companies";
import { listContacts } from "@/lib/crm/contacts";
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
  filters.limit = 100;
  const [listed, companies, contacts] = await Promise.all([
    listActivities(user, filters),
    listCompanies(user, { limit: 100, sort: "name", order: "asc" }),
    listContacts(user, { limit: 100 }),
  ]);

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
      query={filters.query ?? ""}
      companies={companies.data}
      contacts={contacts.data}
    />
  );
}
