const KEEP_WHOLE_PATH = new Set(["mail", "settings", "calendar", "capture"]);
const SECTION_INDEX: Record<string, string> = {
  companies: "/",
  boards: "/opportunities",
};

export function sectionIndex(pathname: string) {
  const path = pathname.split(/[?#]/)[0] || "/";
  const section = path.split("/").filter(Boolean)[0];
  if (!section) return "/";
  if (KEEP_WHOLE_PATH.has(section)) return path;
  return SECTION_INDEX[section] ?? `/${section}`;
}

const TILE_TONES = ["orange", "purple", "blue", "green", "teal", "amber", "red", "yellow"] as const;

export type TileTone = (typeof TILE_TONES)[number];

export function workspaceTone(id: string): TileTone {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TILE_TONES[hash % TILE_TONES.length];
}

export function workspaceInitial(name: string) {
  const letter = Array.from(name.trim()).find((char) => /\p{L}|\p{N}/u.test(char));
  return (letter ?? "?").toLocaleUpperCase("en-GB");
}
