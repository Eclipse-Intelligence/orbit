import type { ActivityType } from "@/lib/crm/types";

export const EVERYONE = "all";

export const AGENT_PREFIX = "agent:";

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  email: "Email",
  meeting: "Meeting",
  call: "Call",
  note: "Note",
  research: "Research",
  linkedin: "LinkedIn",
  agent_update: "Agent update",
  other: "Other",
};
