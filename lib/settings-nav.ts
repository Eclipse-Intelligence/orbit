export const SETTINGS_ROOT = "/settings";

export const SETTINGS_PATHS = {
  general: "/settings/general",
  email: "/settings/email",
  calendars: "/settings/calendars",
  connections: "/settings/connections",
  memory: "/settings/memory",
  apiTokens: "/settings/api-tokens",
  aboutYou: "/settings/about-you",
  brand: "/settings/brand",
  knowledge: "/settings/knowledge",
  team: "/settings/team",
  pipeline: "/settings/pipeline",
  tags: "/settings/tags",
  aiFields: "/settings/ai-fields",
  emailTemplates: "/settings/email-templates",
  bookingPage: "/settings/booking-page",
  learning: "/settings/learning",
  tools: "/settings/tools",
  activity: "/settings/activity",
} as const;

export type SettingsPage = keyof typeof SETTINGS_PATHS;

export const SETTINGS_LABELS: Record<SettingsPage, string> = {
  general: "General",
  email: "Email",
  calendars: "Calendars",
  connections: "Connections",
  memory: "Memory",
  apiTokens: "API tokens",
  aboutYou: "About you",
  brand: "Brand",
  knowledge: "Knowledge",
  team: "Team",
  pipeline: "Pipeline",
  tags: "Tags and lifecycles",
  aiFields: "AI fields",
  emailTemplates: "Email templates",
  bookingPage: "Booking page",
  learning: "Learning",
  tools: "Tools",
  activity: "Activity log",
};

export const YOU_PAGES: SettingsPage[] = ["general", "email", "calendars", "connections", "memory", "apiTokens"];

export const WORKSPACE_PAGES: SettingsPage[] = [
  "aboutYou",
  "brand",
  "knowledge",
  "team",
  "pipeline",
  "tags",
  "aiFields",
  "emailTemplates",
  "bookingPage",
  "learning",
  "tools",
  "activity",
];

const SINGLE_PAGES: SettingsPage[] = [
  "general",
  "email",
  "calendars",
  "bookingPage",
  "connections",
  "apiTokens",
  "brand",
  "knowledge",
  "team",
  "pipeline",
  "tags",
  "aiFields",
  "emailTemplates",
  "learning",
  "tools",
  "activity",
];

export type SettingsNavItem = { page: SettingsPage; href: string; label: string };

export type SettingsNavGroup = {
  kind: "you" | "workspace" | "all";
  heading: string | null;
  items: SettingsNavItem[];
};

function items(pages: SettingsPage[]): SettingsNavItem[] {
  return pages.map((page) => ({ page, href: SETTINGS_PATHS[page], label: SETTINGS_LABELS[page] }));
}

export function settingsNav(workspace: { name: string; multi: boolean }): SettingsNavGroup[] {
  if (!workspace.multi) return [{ kind: "all", heading: null, items: items(SINGLE_PAGES) }];
  return [
    { kind: "you", heading: "You", items: items(YOU_PAGES) },
    { kind: "workspace", heading: workspace.name, items: items(WORKSPACE_PAGES) },
  ];
}

const HASH_TARGETS: Record<string, string> = {
  account: SETTINGS_PATHS.general,
  you: SETTINGS_PATHS.general,
  notifications: SETTINGS_PATHS.general,
  "meeting-link": SETTINGS_PATHS.general,
  shortcuts: SETTINGS_PATHS.general,
  "about-you": SETTINGS_PATHS.aboutYou,
  email: SETTINGS_PATHS.email,
  microsoft: SETTINGS_PATHS.email,
  mailbox: SETTINGS_PATHS.email,
  addresses: SETTINGS_PATHS.email,
  "new-people": `${SETTINGS_PATHS.email}#addresses`,
  "my-emails": SETTINGS_PATHS.email,
  "sending-addresses": SETTINGS_PATHS.email,
  signatures: SETTINGS_PATHS.email,
  "mail-help": SETTINGS_PATHS.email,
  "read-statuses": SETTINGS_PATHS.email,
  calendars: SETTINGS_PATHS.calendars,
  calendar: SETTINGS_PATHS.calendars,
  integrations: SETTINGS_PATHS.connections,
  connections: SETTINGS_PATHS.connections,
  teams: SETTINGS_PATHS.connections,
  granola: SETTINGS_PATHS.connections,
  readwise: SETTINGS_PATHS.connections,
  recall: SETTINGS_PATHS.connections,
  "linkedin-capture": SETTINGS_PATHS.connections,
  linkedin: SETTINGS_PATHS.connections,
  "ai-accounts": SETTINGS_PATHS.connections,
  chatgpt: SETTINGS_PATHS.connections,
  claude: SETTINGS_PATHS.connections,
  "orbit-agent": SETTINGS_PATHS.connections,
  memory: SETTINGS_PATHS.memory,
  api: SETTINGS_PATHS.apiTokens,
  tokens: SETTINGS_PATHS.apiTokens,
  "personal-tokens": SETTINGS_PATHS.apiTokens,
  "iphone-shortcut": SETTINGS_PATHS.apiTokens,
  brand: SETTINGS_PATHS.brand,
  playbook: SETTINGS_PATHS.brand,
  knowledge: SETTINGS_PATHS.knowledge,
  proof: SETTINGS_PATHS.knowledge,
  team: SETTINGS_PATHS.team,
  members: SETTINGS_PATHS.team,
  invites: SETTINGS_PATHS.team,
  pipeline: SETTINGS_PATHS.pipeline,
  stages: SETTINGS_PATHS.pipeline,
  tags: SETTINGS_PATHS.tags,
  "ai-fields": SETTINGS_PATHS.aiFields,
  "web-checks": SETTINGS_PATHS.aiFields,
  "email-templates": SETTINGS_PATHS.emailTemplates,
  templates: SETTINGS_PATHS.emailTemplates,
  booking: SETTINGS_PATHS.bookingPage,
  "booking-page": SETTINGS_PATHS.bookingPage,
  learning: SETTINGS_PATHS.learning,
  notes: SETTINGS_PATHS.learning,
  watchlist: SETTINGS_PATHS.learning,
  "market-notes": SETTINGS_PATHS.learning,
  grok: SETTINGS_PATHS.learning,
  tools: SETTINGS_PATHS.tools,
  clickup: SETTINGS_PATHS.tools,
  linear: SETTINGS_PATHS.tools,
  enrichment: SETTINGS_PATHS.tools,
  "agent-mailbox": SETTINGS_PATHS.tools,
  agents: SETTINGS_PATHS.tools,
  webhooks: SETTINGS_PATHS.tools,
  "email-and-calendar": SETTINGS_PATHS.tools,
  activity: SETTINGS_PATHS.activity,
  "activity-log": SETTINGS_PATHS.activity,
  activities: SETTINGS_PATHS.activity,
};

export function settingsHashTarget(hash: string) {
  let key = hash.replace(/^#/, "");
  try {
    key = decodeURIComponent(key);
  } catch {
    return null;
  }
  key = key.trim().toLowerCase();
  return Object.hasOwn(HASH_TARGETS, key) ? HASH_TARGETS[key] : null;
}

export function settingsAnchorRedirect(pathname: string, search: string, hash: string) {
  const target = settingsHashTarget(hash);
  if (!target) return null;
  const [path, anchor] = target.split("#");
  if (pathname === path || pathname.startsWith(`${path}/`)) return null;
  return `${path}${search}${anchor ? `#${anchor}` : hash}`;
}

const MOVED_PAGES: Record<string, string> = {
  "/settings/integrations": SETTINGS_PATHS.connections,
  "/settings/api": SETTINGS_PATHS.apiTokens,
};

export function settingsRedirect(search: URLSearchParams) {
  const target =
    search.has("calendar_connected") || search.has("calendar_error")
      ? SETTINGS_PATHS.calendars
      : SETTINGS_PATHS.general;
  const query = search.toString();
  return query ? `${target}?${query}` : target;
}

function withQuery(path: string, search: URLSearchParams) {
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export function legacySettingsHref(pathname: string, search: URLSearchParams) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === SETTINGS_ROOT) return search.size ? settingsRedirect(search) : null;
  const moved = MOVED_PAGES[path];
  return moved ? withQuery(moved, search) : null;
}
