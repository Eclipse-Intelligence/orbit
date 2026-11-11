import { listCompanies, listMembers } from "@/lib/crm/companies";
import { listContacts } from "@/lib/crm/contacts";
import { listOpportunities } from "@/lib/crm/opportunities";
import { listTasks } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import type { Mention } from "@/lib/mentions";
import { listDocuments } from "@/lib/proposals/documents";
import { KIND_LABELS, STATUS_LABELS } from "@/lib/proposals/model";

export type MentionOption = Mention & { detail: string | null };

const PEOPLE_LIMIT = 5;

const ROLE_LABELS = { owner: "Owner", admin: "Admin", member: "Member" } as const;

function rankBy(text: string) {
  const lower = text.toLowerCase();
  return (option: MentionOption) => {
    const name = option.name.toLowerCase();
    if (!lower) return 0;
    if (name.startsWith(lower)) return 0;
    if (name.split(/\s+/).some((word) => word.startsWith(lower))) return 1;
    if (name.includes(lower)) return 2;
    return 3;
  };
}

function ranked(options: MentionOption[], text: string) {
  const rank = rankBy(text);
  return options.map((option, index) => ({ option, index })).sort((a, b) => rank(a.option) - rank(b.option) || a.index - b.index).map(({ option }) => option);
}

export async function searchMentions(user: UserActor, query: string): Promise<MentionOption[]> {
  const text = query.trim().slice(0, 80);
  const [members, contacts, companies, tasks, opportunities, proposals] = await Promise.all([
    listMembers(user).catch(() => []),
    listContacts(user, text ? { query: text, limit: 5 } : { limit: 4, sort: "updated" }),
    listCompanies(user, text ? { query: text, limit: 4, sort: "name", order: "asc" } : { limit: 3, sort: "updated" }),
    text ? listTasks(user, { query: text, view: "all", limit: 3 }) : Promise.resolve({ data: [] }),
    text ? listOpportunities(user, { query: text, limit: 3 }) : Promise.resolve({ data: [] }),
    text ? listDocuments(user, { search: text, limit: 3 }).catch(() => []) : Promise.resolve([]),
  ]);
  const lower = text.toLowerCase();
  const people: MentionOption[] = members
    .filter((member) => member.id !== user.userId && (!lower || member.name.toLowerCase().includes(lower) || (member.email ?? "").toLowerCase().includes(lower)))
    .map((member) => ({ kind: "member" as const, id: member.id, name: member.name, detail: ROLE_LABELS[member.role] }));
  const records: MentionOption[] = [
    ...contacts.data.map((contact) => ({
      kind: "contact" as const,
      id: contact.id,
      name: contact.name,
      detail: [contact.jobTitle, contact.companyName].filter(Boolean).join(" at ") || contact.email,
    })),
    ...companies.data.map((company) => ({ kind: "company" as const, id: company.id, name: company.name, detail: company.domain })),
    ...tasks.data.map((task) => ({ kind: "task" as const, id: task.id, name: task.title, detail: task.companyName ?? task.contactName ?? null })),
    ...opportunities.data.map((opportunity) => ({
      kind: "opportunity" as const,
      id: opportunity.id,
      name: opportunity.name,
      detail: opportunity.companyName ?? null,
    })),
    ...proposals.map((proposal) => ({
      kind: "proposal" as const,
      id: proposal.id,
      name: proposal.title,
      detail: [proposal.kind === "nda" ? KIND_LABELS.nda : null, proposal.companyName, STATUS_LABELS[proposal.status]].filter(Boolean).join(" · "),
    })),
  ];
  return [...ranked(people, text).slice(0, PEOPLE_LIMIT), ...ranked(records, text)];
}
