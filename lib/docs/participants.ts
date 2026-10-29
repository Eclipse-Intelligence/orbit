import type { Participant } from "@/lib/docs/client-types";

const VIEWER_COLOR = "oklch(0.72 0.10 221)";
const PERSON_COLORS = ["oklch(0.74 0.12 50)", "oklch(0.72 0.12 150)", "oklch(0.72 0.11 300)", "oklch(0.75 0.11 95)", "oklch(0.70 0.12 15)", "oklch(0.72 0.10 190)"];

export function participantInitials(name: string) {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return letters || "?";
}

export function viewerParticipant(viewer: { id: string; name: string }): Participant {
  return {
    id: viewer.id,
    name: viewer.name,
    short: viewer.name.split(/\s+/)[0] || viewer.name,
    initials: participantInitials(viewer.name),
    color: VIEWER_COLOR,
    kind: "person",
  };
}

function colorFor(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PERSON_COLORS[hash % PERSON_COLORS.length];
}

export function personParticipant(person: { id: string; name: string } | null, viewerId: string | null): Participant {
  if (!person) return { id: "former-member", name: "Former member", short: "Former member", initials: "?", color: "oklch(0.6 0 0)", kind: "person" };
  if (person.id === viewerId) return viewerParticipant(person);
  return { ...viewerParticipant(person), color: colorFor(person.id) };
}

export const ASSISTANT_PARTICIPANT: Participant = {
  id: "orbit-assistant",
  name: "Orbit assistant",
  short: "Assistant",
  initials: "AI",
  color: "oklch(0.62 0.2 285)",
  kind: "assistant",
};

export function agentParticipant(id: string, name: string): Participant {
  return { id: `agent:${id}`, name, short: name, initials: participantInitials(name), color: "oklch(0.7 0 0)", kind: "mcp" };
}
