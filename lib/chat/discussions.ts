import type { ChatMessage, ChatSubject, ChatSubjectKind } from "@/lib/chat/types";
import { TASKS_PATH } from "@/lib/crm/task-views";
import { pageHref } from "@/lib/docs/routes";
import { sharedThreadHref } from "@/lib/mail/share-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DISCUSSION_PARAM = "discussion";
export const TASK_PARAM = "task";

export function isSubjectKind(value: unknown): value is ChatSubjectKind {
  return value === "task" || value === "doc" || value === "mail_thread";
}

export function readSubject(input: unknown): ChatSubject | null {
  if (!input || typeof input !== "object") return null;
  const { kind, id } = input as { kind?: unknown; id?: unknown };
  if (!isSubjectKind(kind) || typeof id !== "string" || !UUID.test(id)) return null;
  return { kind, id: id.toLowerCase() };
}

export function taskPanelHref(taskId: string, options: { tagged?: boolean } = {}) {
  return options.tagged ? `${TASKS_PATH}?who=tagged&${TASK_PARAM}=${taskId}` : `${TASKS_PATH}?${TASK_PARAM}=${taskId}`;
}

export function discussionHref(subject: ChatSubject) {
  if (subject.kind === "mail_thread") return sharedThreadHref(subject.id, { notes: true });
  return subject.kind === "task" ? taskPanelHref(subject.id) : `${pageHref(subject.id)}?${DISCUSSION_PARAM}=1`;
}

export function draftSubjectKey(subject: ChatSubject) {
  return `${subject.kind}:${subject.id}`;
}

export function discussionCount(messages: ChatMessage[]) {
  let count = 0;
  for (const message of messages) {
    if (message.parentId) continue;
    if (!message.deletedAt) count += 1;
    count += message.replyCount;
  }
  return count;
}

export function countLabel(count: number) {
  return count === 1 ? "1 comment" : `${count} comments`;
}
