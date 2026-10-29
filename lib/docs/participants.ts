import type { Participant } from "@/lib/docs/client-types";

const VIEWER_COLOR = "oklch(0.72 0.10 221)";

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
