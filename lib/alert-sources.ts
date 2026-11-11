export const TEAM_ALERT_SOURCES = ["chat", "mail_share", "task", "doc"] as const;
export type TeamAlertSource = (typeof TEAM_ALERT_SOURCES)[number];

export type AlertSource = "mail" | TeamAlertSource;

export const EVERY_WORKSPACE_SOURCES: readonly string[] = ["mail", "chat", "mail_share", "meta_lead"];

export function landsInSubjectWorkspace(source: TeamAlertSource) {
  return source === "task" || source === "doc";
}
