import { STATUS_LABELS, type DocumentStatus } from "@/lib/proposals/model";

const TONES: Record<DocumentStatus | "expired", "neutral" | "blue" | "purple" | "green" | "red" | "amber" | "orange"> = {
  draft: "neutral",
  sent: "blue",
  viewed: "purple",
  client_signed: "amber",
  completed: "green",
  declined: "red",
  withdrawn: "neutral",
  expired: "orange",
};

export function statusTag(status: DocumentStatus | "expired") {
  return { label: STATUS_LABELS[status], tone: TONES[status] };
}
