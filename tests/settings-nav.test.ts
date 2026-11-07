import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { legacySettingsHref, SETTINGS_PATHS, settingsAnchorRedirect, settingsHashTarget, settingsNav, settingsRedirect, type SettingsPage } from "@/lib/settings-nav";

const query = (value: string) => new URLSearchParams(value);

describe("settings navigation", () => {
  it("shows two groups to someone in two workspaces, You first and then the workspace", () => {
    const groups = settingsNav({ name: "Eclipse", multi: true });
    assert.deepEqual(
      groups.map((group) => [group.heading, group.caption]),
      [
        ["You", "The same in every workspace"],
        ["Eclipse", "Only in Eclipse"],
      ],
    );
    assert.deepEqual(
      groups[0].items.map((item) => item.label),
      ["General", "Email", "Calendars", "Connections", "Memory", "API tokens"],
    );
    assert.deepEqual(
      groups[1].items.map((item) => item.label),
      ["About you", "Brand", "Knowledge", "Team", "Pipeline", "Tags and lifecycles", "AI fields", "Email templates", "Booking page", "Learning", "Tools", "Activity log"],
    );
  });

  it("shows the same pages in one list with no headings or workspace words to someone in one workspace", () => {
    const groups = settingsNav({ name: "Acme", multi: false });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].heading, null);
    assert.equal(groups[0].caption, null);
    const single = groups[0].items.map((item) => item.href).sort();
    const multi = settingsNav({ name: "Acme", multi: true })
      .flatMap((group) => group.items.map((item) => item.href))
      .sort();
    assert.deepEqual(single, multi);
    assert.equal(new Set(single).size, single.length);
    const words = JSON.stringify(groups);
    assert.doesNotMatch(words, /workspace/i);
    assert.doesNotMatch(words, /Acme/);
  });

  it("puts every settings page in exactly one group", () => {
    const pages = settingsNav({ name: "Eclipse", multi: true }).flatMap((group) => group.items.map((item) => item.page));
    assert.deepEqual([...pages].sort(), (Object.keys(SETTINGS_PATHS) as SettingsPage[]).sort());
  });
});

describe("old settings addresses", () => {
  it("redirects the old pages to their new homes and keeps the query", () => {
    assert.equal(legacySettingsHref("/settings/integrations", query("")), SETTINGS_PATHS.connections);
    assert.equal(legacySettingsHref("/settings/integrations/", query("")), SETTINGS_PATHS.connections);
    assert.equal(legacySettingsHref("/settings/integrations", query("error=Nope")), `${SETTINGS_PATHS.connections}?error=Nope`);
    assert.equal(legacySettingsHref("/settings/api", query("")), SETTINGS_PATHS.apiTokens);
    assert.equal(legacySettingsHref("/settings/email-templates", query("")), null);
    assert.equal(legacySettingsHref("/settings/general", query("")), null);
    assert.equal(legacySettingsHref("/settings/api-tokens", query("")), null);
    assert.equal(legacySettingsHref("/settingsx", query("")), null);
  });

  it("lets /settings show the phone list, and sends a query to the page it belongs to", () => {
    assert.equal(legacySettingsHref("/settings", query("")), null);
    assert.equal(legacySettingsHref("/settings/", query("")), null);
    assert.equal(legacySettingsHref("/settings/", query("a=1&b=2&b=3")), `${SETTINGS_PATHS.general}?a=1&b=2&b=3`);
    assert.equal(legacySettingsHref("/settings", query("calendar_connected=me%40example.com")), `${SETTINGS_PATHS.calendars}?calendar_connected=me%40example.com`);
    assert.equal(settingsRedirect(query("calendar_error=Nope")), `${SETTINGS_PATHS.calendars}?calendar_error=Nope`);
  });

  it("sends old anchors to the page that now holds them", () => {
    assert.equal(settingsHashTarget("#microsoft"), SETTINGS_PATHS.email);
    assert.equal(settingsHashTarget("#new-people"), `${SETTINGS_PATHS.email}#addresses`);
    assert.equal(settingsHashTarget("#sending-addresses"), SETTINGS_PATHS.email);
    assert.equal(settingsHashTarget("#signatures"), SETTINGS_PATHS.email);
    assert.equal(settingsHashTarget("#my-emails"), SETTINGS_PATHS.email);
    assert.equal(settingsHashTarget("#granola"), SETTINGS_PATHS.connections);
    assert.equal(settingsHashTarget("#Readwise"), SETTINGS_PATHS.connections);
    assert.equal(settingsHashTarget("#ai-accounts"), SETTINGS_PATHS.connections);
    assert.equal(settingsHashTarget("#clickup"), SETTINGS_PATHS.tools);
    assert.equal(settingsHashTarget("#linear"), SETTINGS_PATHS.tools);
    assert.equal(settingsHashTarget("#webhooks"), SETTINGS_PATHS.tools);
    assert.equal(settingsHashTarget("#agents"), SETTINGS_PATHS.tools);
    assert.equal(settingsHashTarget("#web-checks"), SETTINGS_PATHS.aiFields);
    assert.equal(settingsHashTarget("#personal-tokens"), SETTINGS_PATHS.apiTokens);
    assert.equal(settingsHashTarget("#memory"), SETTINGS_PATHS.memory);
    assert.equal(settingsHashTarget("#watchlist"), SETTINGS_PATHS.learning);
    assert.equal(settingsHashTarget("#about-you"), SETTINGS_PATHS.aboutYou);
    assert.equal(settingsHashTarget("#integrations"), SETTINGS_PATHS.connections);
    assert.equal(settingsHashTarget("#calendars"), SETTINGS_PATHS.calendars);
    assert.equal(settingsHashTarget("#Pipeline"), SETTINGS_PATHS.pipeline);
    assert.equal(settingsHashTarget(""), null);
    assert.equal(settingsHashTarget("#constructor"), null);
    assert.equal(settingsHashTarget("#%E0%A4%A"), null);
  });

  it("stays on a page or one of its sub-pages, and keeps or replaces the anchor when it moves", () => {
    assert.equal(settingsAnchorRedirect("/settings/brand/playbook", "", "#playbook"), null);
    assert.equal(settingsAnchorRedirect("/settings/brand", "", "#playbook"), null);
    assert.equal(settingsAnchorRedirect("/settings/general", "?a=1", "#clickup"), "/settings/tools?a=1#clickup");
    assert.equal(settingsAnchorRedirect("/settings/connections", "", "#new-people"), "/settings/email#addresses");
    assert.equal(settingsAnchorRedirect("/settings/email", "", "#new-people"), null);
    assert.equal(settingsAnchorRedirect("/settings/general", "", "#nothing-here"), null);
  });

  it("never sends a card's own anchor away from the page it is on", () => {
    const cards: Record<string, string[]> = {
      [SETTINGS_PATHS.general]: ["account", "you", "notifications", "meeting-link", "shortcuts"],
      [SETTINGS_PATHS.email]: ["addresses", "microsoft", "sending-addresses", "my-emails", "signatures", "mail-help", "read-statuses"],
      [SETTINGS_PATHS.connections]: ["teams", "granola", "readwise", "recall", "linkedin-capture", "ai-accounts", "orbit-agent"],
      [SETTINGS_PATHS.memory]: ["memory"],
      [SETTINGS_PATHS.apiTokens]: ["personal-tokens", "iphone-shortcut"],
      [SETTINGS_PATHS.aboutYou]: ["about-you"],
      [SETTINGS_PATHS.aiFields]: ["web-checks"],
      [SETTINGS_PATHS.learning]: ["learning", "notes", "watchlist", "market-notes", "grok"],
      [SETTINGS_PATHS.tools]: ["clickup", "enrichment", "agent-mailbox", "linear", "agents", "webhooks"],
    };
    for (const [page, ids] of Object.entries(cards)) {
      for (const id of ids) assert.equal(settingsHashTarget(`#${id}`), page, `#${id}`);
    }
  });
});
