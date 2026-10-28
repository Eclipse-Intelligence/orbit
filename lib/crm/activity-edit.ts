import type { Activity, ActivityType } from "@/lib/crm/types";

export const ACTIVITY_EDIT_FIELDS = ["type", "title", "body", "occurredAt", "companyId", "contactId", "opportunityId"] as const;

export type ActivityEditField = (typeof ACTIVITY_EDIT_FIELDS)[number];

export type ActivityEdit = {
  type?: ActivityType;
  title?: string | null;
  body?: string | null;
  occurredAt?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
};

export type ActivityOrigin = "logged" | "mail" | "conversation";

export const ACTIVITY_FIELD_LABELS: Record<ActivityEditField, string> = {
  type: "Type",
  title: "Title",
  body: "Text",
  occurredAt: "When",
  companyId: "Company",
  contactId: "Person",
  opportunityId: "Opportunity",
};

export const EDITABLE_TYPES = ["note", "call", "email", "meeting", "research", "linkedin", "other"] as const satisfies readonly ActivityType[];

const MAIL_KEYS = ["mailMessageId", "internetMessageId", "providerMessageId"];
const CONVERSATION_SOURCES = ["microsoft_teams", "teams", "granola"];
const CONVERSATION_KEYS = ["providerCallId", "transcriptId", "externalId"];

const EDITABLE: Record<ActivityOrigin, readonly ActivityEditField[]> = {
  logged: ACTIVITY_EDIT_FIELDS,
  mail: ["companyId", "opportunityId"],
  conversation: ["title", "companyId", "contactId", "opportunityId"],
};

export const ORIGIN_LIMITS: Record<Exclude<ActivityOrigin, "logged">, string> = {
  mail: "This email was filed from Mail, so only its company and opportunity can change.",
  conversation: "This call or meeting came from Teams, Granola or a transcript, so only its title, company, person and opportunity can change.",
};

export function activityOrigin(activity: Pick<Activity, "type" | "metadata">, hasTranscript = false): ActivityOrigin {
  const metadata = activity.metadata ?? {};
  const has = (key: string) => typeof metadata[key] === "string" && metadata[key] !== "";
  if (activity.type === "email" && (metadata.source === "microsoft" || MAIL_KEYS.some(has))) return "mail";
  if (hasTranscript || CONVERSATION_SOURCES.includes(String(metadata.source ?? "")) || CONVERSATION_KEYS.some(has)) return "conversation";
  return "logged";
}

export function editableFields(origin: ActivityOrigin) {
  return EDITABLE[origin];
}

export function mayEditActivity(
  viewer: { userId?: string | null; role?: string | null },
  activity: Pick<Activity, "actorUserId">,
) {
  if (viewer.role === "owner" || viewer.role === "admin") return true;
  return Boolean(viewer.userId) && activity.actorUserId === viewer.userId;
}
