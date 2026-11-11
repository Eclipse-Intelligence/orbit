export type PeopleTagMode = "tag" | "share" | "none";

export function peopleTagMode(page: { kind: string; shared: boolean; owner: { id: string } }, viewerId: string | null | undefined): PeopleTagMode {
  if (page.kind !== "note") return "none";
  if (page.shared) return "tag";
  return viewerId && page.owner.id === viewerId ? "share" : "none";
}

export function memberTagCount(text: string) {
  return text.split("](member:").length - 1;
}
