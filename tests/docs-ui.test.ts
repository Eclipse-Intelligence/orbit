import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendDailyEntry, shiftDate } from "@/lib/docs/daily";
import { wordDiff } from "@/lib/docs/diff";
import { draftToRestore } from "@/lib/docs/drafts";
import { dayName, monthGrid, whenLabel } from "@/lib/docs/format";
import {
  entryCount,
  findTags,
  headingsIn,
  highlightIn,
  linkTitlesIn,
  parseLinks,
  parseMentions,
  parseTags,
  plainText,
  rewriteLinkTitle,
  splitTarget,
  tagAt,
  tagPrefixCounts,
  tagTree,
  toggleTaskMarker,
  triggerBefore,
  wordCount,
} from "@/lib/docs/markdown";
import { listHref, pageHref, parseDocsRoute, recordHref } from "@/lib/docs/routes";

const ACME = "@[Acme](company:5a8f2c10-6b1e-4c39-9d0a-0c1a2b3c4d01)";

describe("docs links and tags", () => {
  it("finds wiki links with headings and labels", () => {
    const links = parseLinks("See [[Northwind MSA redlines]] and [[Acme pricing notes#Renewal call|the call]].");
    assert.deepEqual(
      links.map((link) => [link.title, link.heading, link.label]),
      [
        ["Northwind MSA redlines", null, null],
        ["Acme pricing notes", "Renewal call", "the call"],
      ],
    );
    assert.equal(links[0].start, 4);
    assert.deepEqual(splitTarget("2026-10-27|Tue 27 Oct"), { target: "2026-10-27", title: "2026-10-27", heading: null, label: "Tue 27 Oct" });
    assert.deepEqual(parseLinks("[[]] and [[a\nb]]"), []);
  });

  it("finds tags only at word boundaries", () => {
    const text = "Plan #partners/q4, item #1, c#sharp, https://a.b/#anchor, [[Note#Heading]] and #clients/acme.";
    assert.deepEqual(
      findTags(text).map((tag) => tag.tag),
      ["partners/q4", "clients/acme"],
    );
    assert.deepEqual(findTags("## Heading"), []);
    assert.deepEqual(parseTags("#Clients/Acme and `#code` and\n```\n#fenced\n```"), ["clients/acme"]);
    assert.deepEqual(tagAt("#clients/acme, more"), { tag: "clients/acme", length: 13 });
    assert.equal(tagAt("#1"), null);
  });

  it("builds the tag tree with page counts", () => {
    const tree = tagTree(tagPrefixCounts([["clients/acme", "q4"], ["clients/northwind"], ["clients/acme", "clients"]]));
    assert.deepEqual(
      tree.map((node) => [node.path, node.count, node.children.map((child) => [child.name, child.count])]),
      [
        [
          "clients",
          3,
          [
            ["acme", 2],
            ["northwind", 1],
          ],
        ],
        ["q4", 1, []],
      ],
    );
  });

  it("detects the picker trigger before the cursor", () => {
    assert.deepEqual(triggerBefore("Renewal plan in [[Acme ren"), { kind: "link", from: 16, query: "Acme ren" });
    assert.equal(triggerBefore("Done [[Acme]] now"), null);
    assert.deepEqual(triggerBefore("Tagged #clients/ac"), { kind: "tag", from: 7, query: "clients/ac" });
    assert.equal(triggerBefore("# "), null);
    assert.equal(triggerBefore("issue #1"), null);
    assert.deepEqual(triggerBefore("Call with @Lena Or"), { kind: "mention", from: 10, query: "Lena Or" });
    assert.equal(triggerBefore("mail me@example"), null);
  });

  it("renames links to a note without touching others", () => {
    const body = "See [[Old name]], [[old name#Part|label]] and [[Other]].";
    assert.equal(rewriteLinkTitle(body, "Old name", "New name").content, "See [[New name]], [[New name#Part|label]] and [[Other]].");
  });

  it("reads mentions and link titles from a body", () => {
    const body = `${ACME} and ${ACME} with [[A]] and [[B#x]]`;
    assert.equal(parseMentions(body).length, 1);
    assert.deepEqual(linkTitlesIn(body), ["A", "B"]);
  });
});

describe("docs text helpers", () => {
  it("turns Markdown into plain text for snippets and counts", () => {
    const body = `## Where we are\n\n- [x] **Acme** ${ACME} signed. See [[Northwind MSA redlines|the redlines]] and \`code\`.`;
    assert.equal(plainText(body), "Where we are Acme Acme signed. See the redlines and code.");
    assert.equal(wordCount(body), 11);
  });

  it("lists headings outside code", () => {
    assert.deepEqual(
      headingsIn("# One\n```\n# not\n```\n### Three ###").map((heading) => [heading.level, heading.text, heading.line]),
      [
        [1, "One", 0],
        [3, "Three", 4],
      ],
    );
  });

  it("finds the match to highlight in a snippet", () => {
    assert.deepEqual(highlightIn("See the Q4 partner strategy", "q4 partner"), { matchFrom: 8, matchTo: 18 });
    assert.deepEqual(highlightIn("Nothing here", "absent"), { matchFrom: 0, matchTo: 0 });
  });

  it("adds timed entries to daily notes", () => {
    assert.equal(appendDailyEntry("", "09:00", " Coffee "), "09:00 Coffee");
    assert.equal(appendDailyEntry("08:42 Slept badly.\n\n", "09:00", "Coffee"), "08:42 Slept badly.\n\n09:00 Coffee");
    assert.equal(entryCount("08:42 One\n\n16:48\n- [ ] Two\n09:1 no"), 2);
  });

  it("toggles task markers", () => {
    assert.equal(toggleTaskMarker("- [ ] Send dates"), "- [x] Send dates");
    assert.equal(toggleTaskMarker("  * [X] Done"), "  * [ ] Done");
    assert.equal(toggleTaskMarker("- plain"), null);
  });
});

describe("docs diffs", () => {
  it("diffs words and keeps the untouched text", () => {
    const parts = wordDiff("in their hands by early December.", "in their hands by 12 December, with the case study.");
    assert.equal(
      parts
        .filter((part) => part.type !== "del")
        .map((part) => part.text)
        .join(""),
      "in their hands by 12 December, with the case study.",
    );
    assert.equal(
      parts
        .filter((part) => part.type !== "add")
        .map((part) => part.text)
        .join(""),
      "in their hands by early December.",
    );
    assert.ok(parts.some((part) => part.type === "del" && part.text.includes("early")));
    assert.deepEqual(wordDiff("same", "same"), [{ type: "same", text: "same" }]);
  });
});

describe("docs routes and dates", () => {
  it("parses routes into a list, a note and a phone level", () => {
    assert.deepEqual(parseDocsRoute("/docs"), { list: { kind: "all" }, pageId: null, date: null, level: "home" });
    assert.deepEqual(parseDocsRoute("/docs/folder/f-1"), { list: { kind: "folder", folderId: "f-1" }, pageId: null, date: null, level: "list" });
    assert.deepEqual(parseDocsRoute("/docs/tag/clients/acme"), { list: { kind: "tag", path: "clients/acme" }, pageId: null, date: null, level: "list" });
    assert.deepEqual(parseDocsRoute("/docs/daily/2026-10-29"), { list: { kind: "daily" }, pageId: null, date: "2026-10-29", level: "note" });
    assert.deepEqual(parseDocsRoute("/docs/abc", "folder=f-1"), { list: { kind: "folder", folderId: "f-1" }, pageId: "abc", date: null, level: "note" });
    assert.deepEqual(parseDocsRoute("/docs", "q=acme"), { list: { kind: "search", query: "acme" }, pageId: null, date: null, level: "list" });
  });

  it("builds links that parse back", () => {
    const list = { kind: "tag" as const, path: "clients/acme" };
    const [path, search] = pageHref("p1", list).split("?");
    assert.deepEqual(parseDocsRoute(path, search).list, list);
    assert.equal(listHref(list), "/docs/tag/clients/acme");
    assert.equal(recordHref("company", "c1"), "/companies/c1");
    assert.equal(recordHref("opportunity", "d1"), "/opportunities/d1");
  });

  it("labels dates the way the list shows them", () => {
    const now = "2026-10-29T16:00:00Z";
    assert.equal(whenLabel("2026-10-29T15:59:30Z", now), "Now");
    assert.equal(whenLabel("2026-10-29T11:20:00Z", now), "11:20");
    assert.equal(whenLabel("2026-10-28T11:20:00Z", now), "Yesterday");
    assert.equal(whenLabel("2026-10-26T11:20:00Z", now), "Mon");
    assert.equal(whenLabel("2026-10-08T11:20:00Z", now), "8 Oct");
    assert.equal(dayName("2026-10-27", "2026-10-29"), "Tuesday");
    assert.equal(shiftDate("2026-10-31", 1), "2026-11-01");
    const grid = monthGrid("2026-10");
    assert.equal(grid.filter((cell) => cell === null).length, 3);
    assert.equal(grid[grid.length - 1], "2026-10-31");
  });

  it("restores a local draft whenever it differs from the server", () => {
    const server = { title: "T", body: "saved", updatedAt: "2026-10-29T10:00:00Z" };
    const at = Date.parse("2026-10-29T10:00:10Z");
    assert.equal(draftToRestore(null, server), null);
    assert.equal(draftToRestore({ title: "T", body: "saved", baseRevision: 1, at }, server), null);
    assert.equal(draftToRestore({ title: "T", body: "old", baseRevision: 1, at: Date.parse("2026-10-28T10:00:00Z") }, server)?.body, "old");
    assert.equal(draftToRestore({ title: "T", body: "typed", baseRevision: 1, at }, server)?.body, "typed");
  });
});
