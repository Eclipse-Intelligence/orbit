import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SHORTCUTS,
  comboMatches,
  isSequencePrefix,
  isSingleKey,
  matchingShortcuts,
  paletteMatches,
  sequenceShortcut,
  shortcutHint,
  shortcutKeys,
  SHORTCUT_BY_ID,
  listSearchHref,
} from "@/lib/shortcuts";

function key(input: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) {
  return { key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...input };
}

describe("keyboard shortcuts", () => {
  it("gives every shortcut a unique id and a way to run it", () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const shortcut of SHORTCUTS) {
      assert.ok(shortcut.combos || shortcut.sequence || shortcut.palette, shortcut.id);
    }
  });

  it("uses ⌘ on a Mac and Ctrl elsewhere", () => {
    const [slash, backup] = SHORTCUT_BY_ID.get("palette")!.combos!;
    assert.equal(comboMatches(slash, key({ key: "/", metaKey: true }), true), true);
    assert.equal(comboMatches(slash, key({ key: "/", ctrlKey: true }), true), false);
    assert.equal(comboMatches(slash, key({ key: "/", ctrlKey: true }), false), true);
    assert.equal(comboMatches(slash, key({ key: "/" }), true), false);
    assert.equal(comboMatches(slash, key({ key: "?", metaKey: true, shiftKey: true }), true), false);
    assert.equal(comboMatches(backup, key({ key: "K", metaKey: true }), true), true);
    assert.ok(matchingShortcuts(key({ key: "/", metaKey: true }), true).some((shortcut) => shortcut.id === "palette"));
    assert.ok(!matchingShortcuts(key({ key: "/", metaKey: true }), true).some((shortcut) => shortcut.id === "search-list"));
  });

  it("keeps shifted letters apart from plain ones", () => {
    const ids = (input: Parameters<typeof key>[0]) => matchingShortcuts(key(input), true).map((shortcut) => shortcut.id);
    assert.ok(ids({ key: "j" }).includes("list-down"));
    assert.ok(!ids({ key: "J", shiftKey: true }).includes("list-down"));
    assert.ok(ids({ key: "J", shiftKey: true }).includes("list-extend-down"));
    assert.ok(ids({ key: "C", shiftKey: true }).includes("call"));
    assert.ok(ids({ key: "?", shiftKey: true }).includes("help"));
    assert.ok(ids({ key: "/" }).includes("search-list"));
    assert.deepEqual(ids({ key: "/", shiftKey: true }), []);
  });

  it("starts G and C sequences and resolves the second key", () => {
    assert.equal(isSequencePrefix(key({ key: "g" })), "g");
    assert.equal(isSequencePrefix(key({ key: "c" })), "c");
    assert.equal(isSequencePrefix(key({ key: "C", shiftKey: true })), null);
    assert.equal(isSequencePrefix(key({ key: "g", metaKey: true })), null);
    assert.equal(sequenceShortcut("g", "c")?.href, "/contacts");
    assert.equal(sequenceShortcut("g", "O")?.href, "/");
    assert.equal(sequenceShortcut("g", "l")?.href, "/calendar");
    assert.equal(sequenceShortcut("c", "t")?.id, "create-task");
    assert.equal(sequenceShortcut("c", "z"), null);
  });

  it("never lets a single key shadow a sequence prefix", () => {
    for (const shortcut of SHORTCUTS) {
      for (const combo of shortcut.combos ?? []) {
        if (combo.mod || combo.alt || combo.shift) continue;
        assert.ok(!["g", "c"].includes(combo.key.toLowerCase()), shortcut.id);
      }
    }
  });

  it("treats only ⌘ combos and Esc as always on", () => {
    assert.equal(isSingleKey(SHORTCUT_BY_ID.get("record-edit")!), true);
    assert.equal(isSingleKey(SHORTCUT_BY_ID.get("go-c")!), true);
    assert.equal(isSingleKey(SHORTCUT_BY_ID.get("palette")!), false);
    assert.equal(isSingleKey(SHORTCUT_BY_ID.get("submit")!), false);
    assert.equal(isSingleKey(SHORTCUT_BY_ID.get("back")!), false);
  });

  it("labels keys for people", () => {
    assert.deepEqual(shortcutKeys(SHORTCUT_BY_ID.get("palette")!, true), ["⌘", "/"]);
    assert.deepEqual(shortcutKeys(SHORTCUT_BY_ID.get("palette")!, false), ["Ctrl", "/"]);
    assert.deepEqual(shortcutKeys(SHORTCUT_BY_ID.get("go-p")!, true), ["G", "P"]);
    assert.deepEqual(shortcutKeys(SHORTCUT_BY_ID.get("help")!, true), ["?"]);
    assert.equal(shortcutHint("go-p", true), "G then P");
    assert.equal(shortcutHint("submit", false), "Ctrl+Enter");
    assert.deepEqual(shortcutKeys(SHORTCUT_BY_ID.get("record-archive")!, true), ["Delete"]);
    assert.deepEqual(shortcutKeys(SHORTCUT_BY_ID.get("record-archive")!, false), ["Backspace"]);
  });

  it("matches palette commands by label, group and keywords", () => {
    const contacts = SHORTCUT_BY_ID.get("go-c")!;
    assert.equal(paletteMatches(contacts, ""), true);
    assert.equal(paletteMatches(contacts, "cont"), true);
    assert.equal(paletteMatches(contacts, "people"), true);
    assert.equal(paletteMatches(contacts, "go people"), true);
    assert.equal(paletteMatches(contacts, "deals"), false);
  });

  it("builds list search links that keep filters and reset paging", () => {
    const params = new URLSearchParams("tag=vip&page=3&q=old");
    assert.equal(listSearchHref("/contacts", params, "q", " acme "), "/contacts?tag=vip&q=acme");
    assert.equal(listSearchHref("/contacts", params, "q", ""), "/contacts?tag=vip");
    assert.equal(listSearchHref("/opportunities", new URLSearchParams("view=board"), "q", "pilot"), "/opportunities?view=board&q=pilot");
  });
});
