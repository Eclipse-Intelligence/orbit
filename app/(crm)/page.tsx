import { redirect } from "next/navigation";
import Companies from "@/components/companies/companies";
import { PAGE_SIZE, pageFromParams, pageOffset } from "@/components/crm/paging";
import { getUserActor } from "@/lib/auth/user";
import { listCompanies, listMembers } from "@/lib/crm/companies";
import { companyHref } from "@/lib/crm/hrefs";
import { getMailbox } from "@/lib/crm/inbox";
import { listLifecycles } from "@/lib/crm/lifecycles";
import { listTags } from "@/lib/crm/tags";
import { companyQueryFromSearchParams } from "@/lib/crm/validation";
import { enrichmentAvailability, getEnrichmentSettings } from "@/lib/enrichment/settings";
import { hiddenAiFields, listAiFields, publicField } from "@/lib/ai-fields/fields";
import { listCompanyViews } from "@/lib/crm/company-views";

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

  const [listed, members, mailbox, tags, lifecycles, settings, aiFields, hidden, views] = await Promise.all([
    listCompanies(user, { ...filters, relationships: true, aiFields: true }),
    listMembers(user),
    getMailbox(user),
    listTags(user),
    listLifecycles(user),
    getEnrichmentSettings(user),
    listAiFields(user),
    hiddenAiFields(user),
    listCompanyViews(user),
  ]);

  const available = enrichmentAvailability();
  const known = new Set(aiFields.map((field) => field.id));
  const shown = {
    ...filters,
    ai: filters.ai?.filter((filter) => known.has(filter.fieldId)),
    aiSort: filters.aiSort && known.has(filters.aiSort) ? filters.aiSort : undefined,
  };

  return (
    <Companies
      companies={listed.data}
      total={listed.total}
      page={page}
      now={requestTime()}
      filters={shown}
      members={members}
      tags={tags}
      lifecycles={lifecycles}
      mailboxConnected={mailbox?.status === "connected"}
      enrichment={{ company: available.company, logoClientId: available.logoClientId, fit: settings.webIcp }}
      aiFields={aiFields.map(publicField)}
      hiddenAiFields={hidden}
      views={views}
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
