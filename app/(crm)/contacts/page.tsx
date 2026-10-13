import { redirect } from "next/navigation";
import ContactsScreen from "@/components/crm/contacts-screen";
import { PAGE_SIZE, pageFromParams, pageOffset } from "@/components/crm/paging";
import { getUserActor } from "@/lib/auth/user";
import { listCompanies, listMembers } from "@/lib/crm/companies";
import { listActivitiesByContact } from "@/lib/crm/activities";
import { getContact, listContacts } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { getMailbox } from "@/lib/crm/inbox";
import { contactQueryFromSearchParams } from "@/lib/crm/validation";

export const dynamic = "force-dynamic";

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
  const filters = contactQueryFromSearchParams(params);
  const page = pageFromParams(params);
  filters.limit = PAGE_SIZE;
  filters.offset = pageOffset(page);
  const contactId = params.get("contact");
  const [listed, companies, members, mailbox, linked] = await Promise.all([
    listContacts(user, filters),
    listCompanies(user, { limit: 100, sort: "name", order: "asc" }),
    listMembers(user),
    getMailbox(user),
    contactId
      ? getContact(user, contactId).catch((error: unknown) => {
          if (error instanceof CrmError && error.code === "not_found")
            return null;
          throw error;
        })
      : Promise.resolve(null),
  ]);
  const contactIds = listed.data.map((contact) => contact.id);
  if (linked && !contactIds.includes(linked.id)) contactIds.push(linked.id);
  const activitiesByContact = await listActivitiesByContact(user, contactIds);

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
      linkedContact={linked}
      total={listed.total}
      page={page}
      query={filters.query ?? ""}
      companies={companies.data}
      members={members}
      mailboxConnected={mailbox?.status === "connected"}
      activitiesByContact={activitiesByContact}
    />
  );
}
