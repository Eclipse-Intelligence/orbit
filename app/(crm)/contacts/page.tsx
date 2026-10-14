import { redirect } from "next/navigation";
import ContactsScreen from "@/components/crm/contacts-screen";
import { PAGE_SIZE, pageFromParams, pageOffset } from "@/components/crm/paging";
import { getUserActor } from "@/lib/auth/user";
import { listCompanies, listMembers } from "@/lib/crm/companies";
import { listContacts } from "@/lib/crm/contacts";
import { contactHref } from "@/lib/crm/hrefs";
import { getMailbox } from "@/lib/crm/inbox";
import { contactQueryFromSearchParams } from "@/lib/crm/validation";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function ContactsPage({
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
  const contactId = params.get("contact");
  if (contactId) redirect(contactHref(contactId));
  const filters = contactQueryFromSearchParams(params);
  const page = pageFromParams(params);
  filters.limit = PAGE_SIZE;
  filters.offset = pageOffset(page);
  const [listed, companies, members, mailbox] = await Promise.all([
    listContacts(user, filters),
    listCompanies(user, { limit: 100, sort: "name", order: "asc" }),
    listMembers(user),
    getMailbox(user),
  ]);

  return (
    <ContactsScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      contacts={listed.data}
      total={listed.total}
      page={page}
      query={filters.query ?? ""}
      companies={companies.data}
      members={members}
      mailboxConnected={mailbox?.status === "connected"}
    />
  );
}
