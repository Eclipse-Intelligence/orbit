import { taskKind } from "@/lib/crm/task-kind";

export type PreparationKind = "brief" | "draft";

export type CallBrief = { who: string; lastContact: string; stage: string | null; openPoints: string[]; talkingPoints: string[] };

export type PreparedEmail = { to: { address: string; name: string | null }[]; subject: string; body: string };

export type PreparationBasis = {
  title: string;
  description: string | null;
  contact: { id: string; name: string; jobTitle: string | null; email: string | null; phone: string | null } | null;
  company: { id: string; name: string } | null;
  opportunity: { id: string; stage: string | null; status: string; value: string | null } | null;
  lastActivity: { type: string; title: string | null; occurredAt: string } | null;
  lastEmailAt: string | null;
  threadLatest: string | null;
};

export type TaskPreparation = {
  kind: PreparationKind;
  brief: CallBrief | null;
  draft: PreparedEmail | null;
  preparedAt: string;
  automatic: boolean;
  stale: boolean;
  builtFrom: PreparationBasis | null;
};

export function preparationKind(title: string | null | undefined): PreparationKind | null {
  const kind = taskKind(title);
  if (kind === "email") return "draft";
  if (kind === "call" || kind === "meeting") return "brief";
  return null;
}

export function preparable(task: { title: string; contactId: string | null; companyId: string | null; opportunityId: string | null }) {
  return preparationKind(task.title) !== null && Boolean(task.contactId || task.companyId || task.opportunityId);
}

export function composeFromPreparation(draft: PreparedEmail) {
  return { to: draft.to.map((person) => ({ address: person.address.toLowerCase(), name: person.name })), subject: draft.subject, body: draft.body };
}

export function briefRows(brief: CallBrief) {
  return [
    { label: "Who", text: brief.who, items: [] as string[] },
    { label: "Last contact", text: brief.lastContact, items: [] as string[] },
    { label: "Stage", text: brief.stage ?? "", items: [] as string[] },
    { label: "Open from last call", text: "", items: brief.openPoints },
    { label: "Talking points", text: "", items: brief.talkingPoints },
  ].filter((row) => row.text.trim() || row.items.length > 0);
}
