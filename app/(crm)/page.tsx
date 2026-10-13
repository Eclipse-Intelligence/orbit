import { redirect } from "next/navigation";
import Companies from "@/components/companies/companies";
import { PAGE_SIZE, pageFromParams, pageOffset } from "@/components/crm/paging";
import { getUserActor } from "@/lib/auth/user";
import { listCompanies, listMembers } from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import { getMailbox } from "@/lib/crm/inbox";
import { getCompanyContext } from "@/lib/crm/relationships";
import { companyQueryFromSearchParams } from "@/lib/crm/validation";

export const dynamic = "force-dynamic";

function requestTime() {
  return Date.now();
}

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
  const page = pageFromParams(params);
  filters.limit = PAGE_SIZE;
  filters.offset = pageOffset(page);

  const record = params.get("record");
  const [listed, members, context, mailbox] = await Promise.all([
    listCompanies(user, filters),
    listMembers(user),
    record
      ? getCompanyContext(user, record).catch((error: unknown) => {
          if (error instanceof CrmError && error.code === "not_found")
            return null;
          throw error;
        })
      : Promise.resolve(null),
    getMailbox(user),
  ]);

  return (
    <Companies
      companies={listed.data}
      total={listed.total}
      page={page}
      now={requestTime()}
      filters={filters}
      members={members}
      context={context}
      mailboxConnected={mailbox?.status === "connected"}
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
    />
  );
}
