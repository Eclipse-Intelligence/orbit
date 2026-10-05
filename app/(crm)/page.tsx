import { redirect } from "next/navigation";
import Sidebar from "@/components/_common/sidebar/sidebar";
import Companies from "@/components/companies/companies";
import { getUserActor } from "@/lib/auth/user";
import { countCompanies, listCompanies, listMembers } from "@/lib/crm/companies";
import { companyQueryFromSearchParams } from "@/lib/crm/validation";

export const dynamic = "force-dynamic";

export default async function CompaniesPage({
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
  const filters = companyQueryFromSearchParams(params);
  filters.limit = 200;

  const [listed, companyCount, members] = await Promise.all([
    listCompanies(user, filters),
    countCompanies(user),
    listMembers(user),
  ]);

  return (
    <main className="flex h-dvh max-w-full overflow-hidden">
      <Sidebar companyCount={companyCount} workspaceName={user.workspaceName} />
      <Companies
        companies={listed.data}
        total={listed.total}
        filters={filters}
        members={members}
        viewer={{
          id: user.userId,
          name: user.fullName || user.email,
          email: user.email,
          role: user.role,
          workspaceName: user.workspaceName,
        }}
      />
    </main>
  );
}
