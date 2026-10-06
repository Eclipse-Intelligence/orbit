import { redirect } from "next/navigation";
import ContactsScreen from "@/components/crm/contacts-screen";
import { getUserActor } from "@/lib/auth/user";
import { listCompanies, listMembers } from "@/lib/crm/companies";
import { listActivitiesByContact } from "@/lib/crm/activities";
import { listContacts } from "@/lib/crm/contacts";
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
  filters.limit = 100;
  const [listed, companies, members, mailbox] = await Promise.all([
    listContacts(user, filters),
    listCompanies(user, { limit: 100, sort: "name", order: "asc" }),
    listMembers(user),
    getMailbox(user),
  ]);
  const activitiesByContact = await listActivitiesByContact(
    user,
    listed.data.map((contact) => contact.id),
  );

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
      query={filters.query ?? ""}
      companies={companies.data}
      members={members}
      mailboxConnected={mailbox?.status === "connected"}
      activitiesByContact={activitiesByContact}
    />
  );
}
