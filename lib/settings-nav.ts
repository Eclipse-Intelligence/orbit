export const SETTINGS_ROOT = "/settings";

export const SETTINGS_PATHS = {
  general: "/settings/general",
  team: "/settings/team",
  emailTemplates: "/settings/email-templates",
  calendars: "/settings/calendars",
  bookingPage: "/settings/booking-page",
  integrations: "/settings/integrations",
  pipeline: "/settings/pipeline",
  tags: "/settings/tags",
  api: "/settings/api",
} as const;

export type SettingsPage = keyof typeof SETTINGS_PATHS;

const HASH_TARGETS: Record<string, string> = {
  team: SETTINGS_PATHS.team,
  members: SETTINGS_PATHS.team,
  invites: SETTINGS_PATHS.team,
  "email-templates": SETTINGS_PATHS.emailTemplates,
  templates: SETTINGS_PATHS.emailTemplates,
  calendars: SETTINGS_PATHS.calendars,
  calendar: SETTINGS_PATHS.calendars,
  booking: SETTINGS_PATHS.bookingPage,
  "booking-page": SETTINGS_PATHS.bookingPage,
  integrations: SETTINGS_PATHS.integrations,
  microsoft: SETTINGS_PATHS.integrations,
  granola: SETTINGS_PATHS.integrations,
  clickup: SETTINGS_PATHS.integrations,
  linear: SETTINGS_PATHS.integrations,
  teams: SETTINGS_PATHS.integrations,
  "ai-accounts": SETTINGS_PATHS.integrations,
  enrichment: SETTINGS_PATHS.integrations,
  chatgpt: SETTINGS_PATHS.integrations,
  claude: SETTINGS_PATHS.integrations,
  pipeline: SETTINGS_PATHS.pipeline,
  stages: SETTINGS_PATHS.pipeline,
  tags: SETTINGS_PATHS.tags,
  api: SETTINGS_PATHS.api,
  agents: SETTINGS_PATHS.api,
  webhooks: SETTINGS_PATHS.api,
  "email-and-calendar": SETTINGS_PATHS.api,
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

export function settingsRedirect(search: URLSearchParams) {
  const target =
    search.has("calendar_connected") || search.has("calendar_error")
      ? SETTINGS_PATHS.calendars
      : SETTINGS_PATHS.general;
  const query = search.toString();
  return query ? `${target}?${query}` : target;
}

export function legacySettingsHref(pathname: string, search: URLSearchParams) {
  if (pathname !== SETTINGS_ROOT && pathname !== `${SETTINGS_ROOT}/`)
    return null;
  return settingsRedirect(search);
}
