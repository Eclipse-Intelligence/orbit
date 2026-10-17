import { listTasks } from "@/lib/crm/tasks";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import ContactRecord from "@/components/crm/contact-record";
import { getUserActor } from "@/lib/auth/user";
import { listActivitiesByContact } from "@/lib/crm/activities";
import { getMeetings } from "@/lib/crm/calendar";
import { getInsightsForActivities } from "@/lib/crm/call-insights";
import { listCompanies, listMembers } from "@/lib/crm/companies";
import { getContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { getMailbox } from "@/lib/crm/inbox";
import { getInviteSetup } from "@/lib/crm/invites";
import { listTags } from "@/lib/crm/tags";
import { contactLookups } from "@/lib/enrichment/contacts";
import { enrichmentAvailability } from "@/lib/enrichment/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const loadContact = cache(async (id: string) => {
  const user = await getUserActor();
  if (!user) return { user: null, contact: null };
  const contact = await getContact(user, id).catch((error: unknown) => {
    if (error instanceof CrmError && error.code === "not_found") return null;
    throw error;
  });
  return { user, contact };
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { contact } = await loadContact(id);
  return { title: contact?.name ?? "Contact not found" };
}

export default async function ContactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { user, contact } = await loadContact(id);
  if (!user) redirect("/login");
  if (!contact) notFound();

  const [
    companies,
    members,
    mailbox,
    activitiesByContact,
    meetings,
    tags,
    invite,
    openTasks,
  ] = await Promise.all([
    listCompanies(user, { limit: 100, sort: "name", order: "asc" }),
    listMembers(user),
    getMailbox(user),
    listActivitiesByContact(user, [contact.id]),
    getMeetings(user, { contactId: contact.id }),
    listTags(user),
    getInviteSetup(user),
    listTasks(user, { contactId: contact.id, view: "all", limit: 50 }),
  ]);
  const available = enrichmentAvailability();
  const lookups = available.email || available.linkedin || available.phone ? await contactLookups(user, [contact.id]) : {};
  const activities = activitiesByContact[contact.id] ?? [];
  const insights = await getInsightsForActivities(
    user,
    activities
      .filter(
        (activity) => activity.type === "call" || activity.type === "meeting",
      )
      .map((activity) => activity.id),
  );

  return (
    <ContactRecord
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      contact={contact}
      tasks={openTasks.data}
      companies={companies.data.map((company) => ({
        id: company.id,
        name: company.name,
      }))}
      members={members}
      mailboxConnected={mailbox?.status === "connected"}
      activities={activities}
      insights={insights}
      meetings={meetings}
      tags={tags}
      invite={invite}
      enrichment={{ available, lookups: lookups[contact.id] ?? {} }}
    />
  );
}
