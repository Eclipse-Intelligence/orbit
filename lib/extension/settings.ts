import type { BrowserSummary } from "@/lib/extension/pairing";
import { appTimeZone, startOfDay } from "@/lib/time";

export type BrowserRowView = {
  id: string;
  name: string;
  usedLabel: string;
  connectedLabel: string;
  active: boolean;
  workspaces: { id: string; name: string }[];
};

const DEFAULT_EXTENSION_URL = "https://github.com/Eclipse-Intelligence/orbit/blob/main/extension/README.md";

export function extensionDownloadUrl(env: Record<string, string | undefined> = process.env) {
  const configured = env.LINKEDIN_EXTENSION_URL?.trim();
  return configured && /^https:\/\//.test(configured) ? configured : DEFAULT_EXTENSION_URL;
}

function format(date: Date, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: appTimeZone() }).format(date);
}

function sameYear(left: Date, right: Date) {
  return format(left, { year: "numeric" }) === format(right, { year: "numeric" });
}

export function browserRows(browsers: BrowserSummary[], now = new Date()): BrowserRowView[] {
  const today = startOfDay(now).getTime();
  return browsers.map((browser) => {
    const used = browser.lastUsedAt ? new Date(browser.lastUsedAt) : null;
    const usedToday = Boolean(used && used.getTime() >= today);
    const usedLabel = !used
      ? "Not used yet"
      : usedToday
        ? `Used today at ${format(used, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`
        : `Last used ${format(used, { day: "numeric", month: "short", ...(sameYear(used, now) ? {} : { year: "numeric" }) })}`;
    return {
      id: browser.id,
      name: browser.name,
      usedLabel,
      connectedLabel: format(new Date(browser.createdAt), { day: "numeric", month: "short", year: "numeric" }),
      active: usedToday,
      workspaces: browser.workspaces,
    };
  });
}
