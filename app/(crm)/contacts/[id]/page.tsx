import { listTasks } from "@/lib/crm/tasks";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import ContactRecord from "@/components/crm/contact-record";
import { getMoveTargets, getUserActor } from "@/lib/auth/user";
import { manualWorkflows } from "@/lib/workflows/store";
import { listDocuments } from "@/lib/proposals/documents";
import { relationshipsFor } from "@/lib/crm/relationship-signals";
import { listActivitiesByContact } from "@/lib/crm/activities";
import { contactSuppression } from "@/lib/campaigns/suppression";
import { contactCampaignLines, contactCampaignTimeline } from "@/lib/campaigns/threads";
import { getMeetings } from "@/lib/crm/calendar";
import { getInsightsForActivities } from "@/lib/crm/call-insights";
import { listCompanies, listMembers } from "@/lib/crm/companies";
import { getContact, listContactsAtCompanies } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { getMailbox } from "@/lib/crm/inbox";
import { getInviteSetup } from "@/lib/crm/invites";
import { listTags } from "@/lib/crm/tags";
import { contactLookups } from "@/lib/enrichment/contacts";
import { latestEmailCheck } from "@/lib/enrichment/email-check";
import { configuredVerifiers } from "@/lib/enrichment/providers";
import { enrichmentAvailability } from "@/lib/enrichment/settings";
import { metaLeadTrails } from "@/lib/crm/meta-outcomes";
import { timelineReads } from "@/lib/mail/tracking";

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
    workflows,
    proposals,
    relationships,
    moveTargets,
    campaignLines,
    campaignRows,
    suppression,
    companyContacts,
  ] = await Promise.all([
    listCompanies(user, { limit: 100, sort: "name", order: "asc" }),
    listMembers(user),
    getMailbox(user),
    listActivitiesByContact(user, [contact.id]),
    getMeetings(user, { contactId: contact.id }),
    listTags(user),
    getInviteSetup(user),
    listTasks(user, { contactId: contact.id, view: "all", limit: 50 }),
    manualWorkflows(user, "contact"),
    listDocuments(user, { contactId: contact.id, limit: 20 }),
    relationshipsFor(user, "contact", [contact.id]),
    getMoveTargets(user),
    contactCampaignLines(user, contact.id).catch((error: unknown) => {
      console.error("Couldn't read the contact's campaigns", error);
      return [];
    }),
    contactCampaignTimeline(user, contact.id).catch((error: unknown) => {
      console.error("Couldn't read the contact's campaign timeline", error);
      return [];
    }),
    contactSuppression(user, contact.id).catch((error: unknown) => {
      console.error("Couldn't read the contact's do not contact status", error);
      return { doNotContact: null, caution: null, blockLine: null };
    }),
    contact.companyId ? listContactsAtCompanies(user, [contact.companyId]) : Promise.resolve([]),
  ]);
  const available = enrichmentAvailability();
  const lookups = available.email || available.linkedin || available.phone ? await contactLookups(user, [contact.id]) : {};
  const canCheckEmail = configuredVerifiers().length > 0;
  const emailCheck = canCheckEmail ? await latestEmailCheck(user, contact.email) : null;
  const activities = activitiesByContact[contact.id] ?? [];
  const metaLeadIds = activities.flatMap((activity) =>
    activity.metadata.source === "meta_lead_ad" && typeof activity.metadata.metaLeadId === "string" ? [activity.metadata.metaLeadId] : [],
  );
  const [insights, reads, metaTrails] = await Promise.all([
    getInsightsForActivities(
      user,
      activities
        .filter(
          (activity) => activity.type === "call" || activity.type === "meeting",
        )
        .map((activity) => activity.id),
    ),
    timelineReads(user, activities),
    metaLeadTrails(user, metaLeadIds).catch((error: unknown) => {
      console.error("Couldn't read the lead's Meta stages", error);
      return {};
    }),
  ]);

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
      workflows={workflows}
      proposals={proposals}
      relationship={relationships[contact.id]}
      moveTargets={moveTargets}
      tasks={openTasks.data}
      companies={companies.data.map((company) => ({
        id: company.id,
        name: company.name,
      }))}
      members={members}
      mailboxConnected={mailbox?.status === "connected"}
      activities={activities}
      insights={insights}
      reads={reads}
      metaTrails={metaTrails}
      campaignLines={campaignLines}
      campaignRows={campaignRows}
      doNotContact={suppression.doNotContact}
      sendCaution={suppression.caution}
      blockLine={suppression.blockLine}
      canSetDoNotContact={user.scopes.includes("campaigns:write")}
      meetings={meetings}
      colleagues={companyContacts.filter((colleague) => colleague.id !== contact.id)}
      tags={tags}
      invite={invite}
      enrichment={{ available, lookups: lookups[contact.id] ?? {}, canCheckEmail, emailCheck }}
    />
  );
}
