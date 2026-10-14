import { redirect } from "next/navigation";
import Companies from "@/components/companies/companies";
import { PAGE_SIZE, pageFromParams, pageOffset } from "@/components/crm/paging";
import { getUserActor } from "@/lib/auth/user";
import { listCompanies, listMembers } from "@/lib/crm/companies";
import { companyHref } from "@/lib/crm/hrefs";
import { getMailbox } from "@/lib/crm/inbox";
import { companyQueryFromSearchParams } from "@/lib/crm/validation";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  const record = params.get("record");
  if (record) redirect(companyHref(record));
  const filters = companyQueryFromSearchParams(params);
  const page = pageFromParams(params);
  filters.limit = PAGE_SIZE;
  filters.offset = pageOffset(page);

  const [listed, members, mailbox] = await Promise.all([
    listCompanies(user, filters),
    listMembers(user),
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
