import type { ProgressStatus } from "@/lib/campaigns/progress";

export const PROGRESS_STATUS_LABELS: Record<ProgressStatus, string> = {
  in_progress: "In progress",
  pending: "Pending",
  replied: "Replied",
  stopped: "Stopped",
  finished: "Finished",
  paused: "Paused",
};
