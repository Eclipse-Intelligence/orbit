export type ShortcutGroup =
  | "General"
  | "Go to"
  | "Create"
  | "Lists"
  | "Selection"
  | "Tasks"
  | "Opportunities"
  | "Records"
  | "Calendar"
  | "Capture"
  | "Mail"
  | "Docs"
  | "Settings";

export type Combo = {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type ShortcutDef = {
  id: string;
  label: string;
  group: ShortcutGroup;
  combos?: Combo[];
  sequence?: [string, string];
  target?: string;
  rowKey?: string;
  href?: string;
  focus?: boolean;
  whileTyping?: boolean;
  inOverlay?: boolean;
  palette?: boolean;
  hidden?: boolean;
  keywords?: string;
};

const SEQUENCE_PREFIXES = ["g", "c"] as const;
export const SEQUENCE_TIMEOUT_MS = 1200;

const NAV: [string, string, string, string?][] = [
  ["m", "Mail", "/mail", "email inbox sent drafts archive"],
  ["o", "Companies", "/", "home organisations"],
  ["c", "Contacts", "/contacts", "people"],
  ["p", "Opportunities", "/opportunities", "deals pipeline"],
  ["t", "Tasks", "/tasks", "to do"],
  ["i", "Capture", "/capture", "inbox filing mailbox connect calls"],
  ["l", "Calendar", "/calendar", "meetings events"],
  ["a", "Activities", "/activities", "timeline notes"],
  ["q", "Quiet", "/quiet", "stale relationships"],
  ["s", "Settings", "/settings", "preferences"],
];

const SETTINGS_SECTIONS: [string, string, string][] = [
  ["General", "/settings/general", "email addresses meeting link account"],
  ["Templates and signatures", "/settings/email-templates", "email templates signatures read statuses tracking"],
  ["Calendars", "/settings/calendars", "outlook ics gmail accounts allow sending"],
  ["Booking page", "/settings/booking-page", "booking scheduling"],
  ["Integrations", "/settings/integrations", "clickup granola microsoft"],
  ["Pipeline", "/settings/pipeline", "stages"],
  ["Tags and lifecycles", "/settings/tags", "labels lifecycles"],
  ["API and webhooks", "/settings/api", "tokens webhooks"],
];

export const SHORTCUTS: ShortcutDef[] = [
  { id: "palette", label: "Command palette", group: "General", combos: [{ key: "/", mod: true }, { key: "k", mod: true }], whileTyping: true, inOverlay: true },
  { id: "assistant", label: "Ask Orbit", group: "General", combos: [{ key: "o" }], palette: true, keywords: "ai assistant chat ask question" },
  { id: "search-list", label: "Search this list", group: "General", combos: [{ key: "/" }], target: "list-search" },
  { id: "help", label: "Keyboard shortcuts", group: "General", combos: [{ key: "?", shift: true }], palette: true, keywords: "help keys" },
  { id: "settings", label: "Settings", group: "General", combos: [{ key: ",", mod: true }], href: "/settings", whileTyping: true, palette: true },
  { id: "sidebar", label: "Collapse or expand the sidebar", group: "General", combos: [{ key: "b", mod: true }], target: "sidebar-toggle" },
  { id: "submit", label: "Submit the form or send", group: "General", combos: [{ key: "Enter", mod: true }], whileTyping: true, inOverlay: true },
  { id: "save", label: "Save", group: "General", combos: [{ key: "s", mod: true }], whileTyping: true, inOverlay: true },
  { id: "back", label: "Back to the list", group: "General", combos: [{ key: "Escape" }], target: "back" },
  { id: "notifications", label: "Notifications", group: "General", combos: [{ key: "n", shift: true }], target: "notifications", palette: true },
  { id: "account", label: "Account", group: "General", combos: [{ key: "a", shift: true }], target: "account", palette: true, keywords: "profile sign out" },
  { id: "quick-add", label: "Quick add menu", group: "Create", combos: [{ key: "q" }], target: "quick-add" },

  ...NAV.map(([key, label, href, keywords]) => ({
    id: `go-${key}`,
    label,
    group: "Go to" as const,
    sequence: ["g", key] as [string, string],
    href,
    palette: true,
    keywords,
  })),
  { id: "go-docs", label: "Docs", group: "Go to", href: "/docs", palette: true, keywords: "notes pages writing folders tags" },
  ...SETTINGS_SECTIONS.map(([label, href, keywords]) => ({
    id: `settings-${href.split("/").pop()}`,
    label: `Settings: ${label}`,
    group: "Settings" as const,
    href,
    palette: true,
    keywords,
  })),

  { id: "create-task", label: "Create task", group: "Create", sequence: ["c", "t"], palette: true, keywords: "new add task" },
  { id: "create-contact", label: "Create contact", group: "Create", sequence: ["c", "c"], palette: true, keywords: "new add person" },
  { id: "create-company", label: "Create company", group: "Create", sequence: ["c", "o"], palette: true, keywords: "new add organisation" },
  { id: "create-opportunity", label: "Create opportunity", group: "Create", sequence: ["c", "p"], palette: true, keywords: "new add deal" },
  { id: "create-email", label: "Send an email", group: "Create", sequence: ["c", "m"], palette: true, keywords: "new mail write compose message" },
  { id: "create-event", label: "Create meeting invite", group: "Create", sequence: ["c", "e"], palette: true, keywords: "new event invite calendar" },
  { id: "create-activity", label: "Create activity", group: "Create", sequence: ["c", "a"], palette: true, keywords: "new note log" },
  { id: "create-note", label: "Create note", group: "Create", sequence: ["c", "n"], palette: true, keywords: "new doc docs page write" },

  { id: "list-down", label: "Next row (or ↓)", group: "Lists", combos: [{ key: "j" }] },
  { id: "list-up", label: "Previous row (or ↑)", group: "Lists", combos: [{ key: "k" }] },
  { id: "list-down-arrow", label: "Next row", group: "Lists", combos: [{ key: "ArrowDown" }], hidden: true },
  { id: "list-up-arrow", label: "Previous row", group: "Lists", combos: [{ key: "ArrowUp" }], hidden: true },
  { id: "list-open", label: "Open the highlighted row", group: "Lists", combos: [{ key: "Enter" }] },
  { id: "list-select", label: "Select the highlighted row", group: "Selection", combos: [{ key: "x" }], rowKey: "x" },
  { id: "list-extend-down", label: "Extend selection down", group: "Selection", combos: [{ key: "j", shift: true }, { key: "ArrowDown", shift: true }] },
  { id: "list-extend-up", label: "Extend selection up", group: "Selection", combos: [{ key: "k", shift: true }, { key: "ArrowUp", shift: true }] },
  { id: "list-select-all", label: "Select all on this page", group: "Selection", combos: [{ key: "a", mod: true }], target: "select-all" },
  { id: "page-prev", label: "Previous page", group: "Lists", combos: [{ key: "[" }], target: "page-prev" },
  { id: "page-next", label: "Next page", group: "Lists", combos: [{ key: "]" }], target: "page-next" },
  { id: "list-filter", label: "Filter", group: "Lists", combos: [{ key: "f" }], target: "filter" },
  { id: "list-clear", label: "Clear search and filters", group: "Lists", combos: [{ key: "f", shift: true }], target: "clear-filters", palette: true },
  { id: "export", label: "Export to CSV", group: "Lists", target: "export", palette: true, keywords: "download csv" },
  { id: "import", label: "Import CSV", group: "Lists", target: "import", palette: true, keywords: "upload csv" },
  { id: "add-record", label: "Add on this page", group: "Lists", target: "add-record", palette: true, keywords: "new" },

  { id: "bulk-email", label: "Email the selected people", group: "Selection", combos: [{ key: "e" }], target: "bulk-email" },
  { id: "bulk-tag", label: "Tag the selection", group: "Selection", combos: [{ key: "l" }], target: "bulk-tag" },
  { id: "bulk-archive", label: "Archive the selection", group: "Selection", combos: [{ key: "Backspace" }, { key: "Delete" }], target: "bulk-archive" },
  { id: "bulk-export", label: "Export the selection", group: "Selection", target: "bulk-export", palette: true },
  { id: "bulk-undo", label: "Undo archive", group: "Selection", combos: [{ key: "z" }], target: "bulk-undo" },

  { id: "task-done", label: "Mark the task done", group: "Tasks", combos: [{ key: "d" }], rowKey: "d" },
  { id: "task-expand", label: "Show task details", group: "Tasks", combos: [{ key: " " }], rowKey: "space" },
  ...[1, 2, 3, 4, 5, 6].map((index) => ({
    id: `tab-${index}`,
    label: index === 1 ? "Switch tab (1 to 6)" : `Tab ${index}`,
    group: "Tasks" as const,
    combos: [{ key: String(index) }],
    target: `tab-${index}`,
    hidden: index > 1,
  })),

  { id: "toggle-view", label: "Switch list and board", group: "Opportunities", combos: [{ key: "v" }], target: "toggle-view", palette: true },

  { id: "record-edit", label: "Edit", group: "Records", combos: [{ key: "e" }], target: "edit", palette: true },
  { id: "record-archive", label: "Archive", group: "Records", combos: [{ key: "Backspace" }, { key: "Delete" }], target: "archive", palette: true },
  { id: "record-next", label: "Next record in the list", group: "Records", combos: [{ key: "j" }] },
  { id: "record-prev", label: "Previous record in the list", group: "Records", combos: [{ key: "k" }] },
  { id: "compose-note", label: "Write a note", group: "Records", combos: [{ key: "n" }], palette: true },
  { id: "compose-call", label: "Log a call", group: "Records", combos: [{ key: "l" }], palette: true },
  { id: "compose-email", label: "Write an email", group: "Records", combos: [{ key: "m" }], palette: true },
  { id: "use-template", label: "Insert an email template", group: "Records", combos: [{ key: "t", mod: true, shift: true }], target: "use-template", whileTyping: true, inOverlay: true },
  { id: "add-person", label: "Add or link a person", group: "Records", combos: [{ key: "a" }], target: "add-person", palette: true },
  { id: "invite", label: "Invite to a meeting", group: "Records", combos: [{ key: "i" }], target: "invite", palette: true },
  { id: "call", label: "Call in Teams", group: "Records", combos: [{ key: "c", shift: true }], target: "call", palette: true },
  { id: "add-tag", label: "Add a tag", group: "Records", combos: [{ key: "t" }], target: "add-tag", palette: true },
  { id: "timeline-filter", label: "Filter the timeline", group: "Records", combos: [{ key: "f" }], target: "timeline-filter", focus: true },

  { id: "calendar-today", label: "Today", group: "Calendar", combos: [{ key: "t" }], target: "today", palette: true },
  { id: "calendar-prev", label: "Previous week or day", group: "Calendar", combos: [{ key: "[" }, { key: "ArrowLeft" }], target: "calendar-prev" },
  { id: "calendar-next", label: "Next week or day", group: "Calendar", combos: [{ key: "]" }, { key: "ArrowRight" }], target: "calendar-next" },
  { id: "calendar-day", label: "Day view", group: "Calendar", combos: [{ key: "d" }], target: "view-day", palette: true },
  { id: "calendar-week", label: "Week view", group: "Calendar", combos: [{ key: "w" }], target: "view-week", palette: true },
  { id: "calendar-panel", label: "Show or hide calendars", group: "Calendar", combos: [{ key: "\\" }], target: "calendars-panel", palette: true },
  { id: "event-join", label: "Join the meeting", group: "Calendar", combos: [{ key: "j" }], target: "join", inOverlay: true },
  { id: "event-cancel", label: "Cancel the meeting", group: "Calendar", combos: [{ key: "Backspace" }, { key: "Delete" }], target: "cancel-meeting", inOverlay: true },

  { id: "mail-reply", label: "Reply", group: "Mail", combos: [{ key: "r" }] },
  { id: "mail-reply-all", label: "Reply all", group: "Mail", combos: [{ key: "a" }] },
  { id: "mail-forward", label: "Forward", group: "Mail", combos: [{ key: "f" }] },
  { id: "mail-next-split", label: "Next split (Important, Other, News, Calendar)", group: "Mail", combos: [{ key: "Tab" }] },
  { id: "mail-prev-split", label: "Previous split", group: "Mail", combos: [{ key: "Tab", shift: true }] },
  { id: "mail-archive", label: "Archive", group: "Mail", combos: [{ key: "e" }] },
  { id: "mail-ai-write", label: "Write with AI (in an email)", group: "Mail", combos: [{ key: "j", mod: true }], whileTyping: true, inOverlay: true },
  { id: "mail-snooze", label: "Remind me (snooze)", group: "Mail", combos: [{ key: "h" }] },
  { id: "mail-trash", label: "Move to Trash", group: "Mail", combos: [{ key: "#" }, { key: "#", shift: true }, { key: "#", alt: true }, { key: "Backspace" }, { key: "Delete" }] },
  { id: "mail-read", label: "Mark read or unread", group: "Mail", combos: [{ key: "u" }] },
  { id: "mail-flag", label: "Flag or unflag", group: "Mail", combos: [{ key: "s" }] },
  { id: "mail-undo", label: "Undo the last move", group: "Mail", combos: [{ key: "z" }] },
  { id: "mail-refresh", label: "Check for new mail", group: "Mail", combos: [{ key: "r", shift: true }], palette: true, keywords: "sync refresh email" },

  { id: "docs-search", label: "Search docs", group: "Docs", combos: [{ key: "f", mod: true, shift: true }], whileTyping: true, palette: true, keywords: "find notes text" },
  { id: "docs-daily", label: "Today's daily note", group: "Docs", sequence: ["g", "d"], palette: true, keywords: "journal today docs" },
  { id: "docs-focus", label: "Focus mode", group: "Docs", combos: [{ key: "Enter", mod: true, shift: true }], whileTyping: true, keywords: "full screen write" },
  { id: "docs-panel", label: "Show or hide backlinks", group: "Docs", combos: [{ key: "\\", mod: true }], whileTyping: true, keywords: "panel links details" },

  { id: "inbox-sync", label: "Sync Capture", group: "Capture", combos: [{ key: "s" }], target: "sync", palette: true },
  { id: "inbox-file", label: "File the conversation to…", group: "Capture", combos: [{ key: "f" }], rowKey: "f" },
  { id: "inbox-add", label: "Add as a contact", group: "Capture", combos: [{ key: "a" }], rowKey: "a" },
  { id: "inbox-ignore", label: "Ignore the conversation", group: "Capture", combos: [{ key: "i" }], rowKey: "i" },
  { id: "inbox-hide", label: "Hide the person", group: "Capture", combos: [{ key: "h" }], rowKey: "h" },
];

export const SHORTCUT_BY_ID = new Map(SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));

type KeyEventLike = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

function normalKey(key: string) {
  return key.length === 1 ? key.toLowerCase() : key;
}

export function comboMatches(combo: Combo, event: KeyEventLike, mac: boolean) {
  const mod = mac ? event.metaKey : event.ctrlKey;
  const other = mac ? event.ctrlKey : event.metaKey;
  if (Boolean(combo.mod) !== mod || other) return false;
  if (Boolean(combo.alt) !== event.altKey) return false;
  const key = normalKey(event.key);
  if (combo.key === "?" || combo.key === "/") {
    if (key !== combo.key) return false;
    return combo.key === "?" || !event.shiftKey;
  }
  if (Boolean(combo.shift) !== event.shiftKey) return false;
  return key === normalKey(combo.key);
}

export function matchingShortcuts(event: KeyEventLike, mac: boolean) {
  return SHORTCUTS.filter((shortcut) => shortcut.combos?.some((combo) => comboMatches(combo, event, mac)));
}

export function sequenceShortcut(prefix: string, key: string) {
  const wanted = normalKey(key);
  return SHORTCUTS.find((shortcut) => shortcut.sequence?.[0] === prefix && shortcut.sequence[1] === wanted) ?? null;
}

export function isSequencePrefix(event: KeyEventLike) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  const key = normalKey(event.key);
  return (SEQUENCE_PREFIXES as readonly string[]).includes(key) ? key : null;
}

export function isSingleKey(shortcut: ShortcutDef) {
  if (shortcut.sequence) return true;
  return Boolean(shortcut.combos?.some((combo) => !combo.mod && !combo.alt && combo.key !== "Escape"));
}

const KEY_LABELS: Record<string, string> = {
  Enter: "Enter",
  Escape: "Esc",
  Delete: "Del",
  ArrowDown: "↓",
  ArrowUp: "↑",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
  Tab: "Tab",
};

export function comboLabel(combo: Combo, mac: boolean) {
  const parts: string[] = [];
  if (combo.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (combo.alt) parts.push(mac ? "⌥" : "Alt");
  if (combo.shift && combo.key !== "?") parts.push(mac ? "⇧" : "Shift");
  if (combo.key === "Backspace") parts.push(mac ? "Delete" : "Backspace");
  else parts.push(KEY_LABELS[combo.key] ?? combo.key.toUpperCase());
  return parts;
}

export function shortcutKeys(shortcut: ShortcutDef, mac: boolean) {
  if (shortcut.sequence) return shortcut.sequence.map((key) => key.toUpperCase());
  const combo = shortcut.combos?.[0];
  return combo ? comboLabel(combo, mac) : [];
}

export function shortcutHint(id: string, mac: boolean) {
  const shortcut = SHORTCUT_BY_ID.get(id);
  if (!shortcut) return "";
  const keys = shortcutKeys(shortcut, mac);
  return shortcut.sequence ? keys.join(" then ") : keys.join(mac ? "" : "+");
}

export function paletteMatches(shortcut: ShortcutDef, query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${shortcut.label} ${shortcut.group} ${shortcut.keywords ?? ""}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export const KEYBOARD_ROW_CLASS =
  "outline-none scroll-my-2 data-[kb-active=true]:bg-white/5 data-[kb-active=true]:shadow-[inset_2px_0_0_0_var(--primary)]";

const RESET_PARAMS = ["page", "cursor"];

export function listSearchHref(pathname: string, params: URLSearchParams, param: string, query: string) {
  const next = new URLSearchParams(params);
  for (const key of RESET_PARAMS) next.delete(key);
  const trimmed = query.trim();
  if (trimmed) next.set(param, trimmed);
  else next.delete(param);
  const text = next.toString();
  return text ? `${pathname}?${text}` : pathname;
}
