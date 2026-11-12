import type { ChatPerson } from "@/lib/chat/types";
import type { MailShareCandidate, MailSharePerson, SharedThreadSummary } from "@/lib/mail/share-types";

export const SHARED_VIEW = "shared";

export const SHARE_REACH = "They see this thread, its attachments and notes. Nothing else in your mailbox. Only you can send.";

export function personFirstName(name: string | null | undefined, fallback = "Someone") {
  return name?.trim().split(/\s+/)[0] || fallback;
}

export function sharedByLabel(owner: Pick<ChatPerson, "name">) {
  return `Shared by ${personFirstName(owner.name)}`;
}

export function removedLine(owner: Pick<ChatPerson, "name">) {
  return `${personFirstName(owner.name)} removed you from this thread.`;
}

export function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function peopleLine(people: Pick<MailSharePerson, "id" | "name">[], viewerId: string) {
  const others = people.filter((person) => person.id !== viewerId).map((person) => personFirstName(person.name));
  const inside = people.some((person) => person.id === viewerId);
  return joinNames(inside ? [...others, "you"] : others);
}

export function addPeopleQuestion(people: Pick<ChatPerson, "name">[]) {
  return `Add ${joinNames(people.map((person) => personFirstName(person.name)))} to this thread?`;
}

export function sharedCountLabel(count: number) {
  return count === 1 ? "1 shared thread" : `${count} shared threads`;
}

export function stepShare(threads: Pick<SharedThreadSummary, "shareId">[], cursor: string | null, delta: number) {
  if (threads.length === 0) return null;
  const index = cursor ? threads.findIndex((thread) => thread.shareId === cursor) : -1;
  if (index === -1) return threads[delta > 0 ? 0 : threads.length - 1].shareId;
  return threads[Math.min(threads.length - 1, Math.max(0, index + delta))].shareId;
}

export function sortShared(threads: SharedThreadSummary[]) {
  const time = (thread: SharedThreadSummary) => thread.latestAt ?? thread.sharedAt;
  return [...threads].sort((a, b) => (time(a) < time(b) ? 1 : time(a) > time(b) ? -1 : 0));
}

export function sharedListPerson(thread: Pick<SharedThreadSummary, "counterpart" | "owner">) {
  return thread.counterpart?.name?.trim() || thread.counterpart?.address || thread.owner.name;
}

export function readShareParam(value: string | null | undefined) {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
}

const ROLE_LABELS = { owner: "Owner", admin: "Admin", member: "Member" } as const;

export function candidateDetail(person: Pick<MailShareCandidate, "role" | "email">) {
  return person.role ? ROLE_LABELS[person.role] : person.email;
}

export const NO_ACCESS = "You no longer have access to this thread.";

export type MailListQuery = { view: string; account: string | null; query: string };

export const HOME_VIEW = "inbox";

export function isSharedView(query: MailListQuery) {
  return !query.query && query.view === SHARED_VIEW;
}

export function mailUrl(query: MailListQuery, thread: string | null) {
  const params = new URLSearchParams();
  if (query.query) params.set("q", query.query);
  else if (query.view !== HOME_VIEW) params.set("view", query.view);
  if (query.account) params.set("account", query.account);
  if (thread) params.set(isSharedView(query) ? "shared" : "thread", thread);
  const text = params.toString();
  return text ? `/mail?${text}` : "/mail";
}

export function listForThread(query: MailListQuery): MailListQuery | null {
  return isSharedView(query) ? { view: HOME_VIEW, account: query.account, query: "" } : null;
}
