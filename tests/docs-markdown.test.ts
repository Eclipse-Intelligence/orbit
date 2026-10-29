import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendDailyEntry, isDailyDate, localDate, parseDailyEntries, shiftDate } from "@/lib/docs/daily";
import { diffCounts, lineDiff } from "@/lib/docs/diff";
import { appendText, applyDocEdit, findAndReplace, retag } from "@/lib/docs/edits";
import { excerptFrom, maskCode, normaliseTag, parseDoc, parseLinks, parseMentions, parseTags, rewriteLinkTitle, wordCount } from "@/lib/docs/markdown";

const ACME = "11111111-1111-4111-8111-111111111111";
const LENA = "22222222-2222-4222-8222-222222222222";

describe("doc links", () => {
  it("reads [[links]] with headings and labels, and skips code", () => {
    const content = [
      "See [[Northwind MSA redlines]] and [[Q4 plan#Risks|the risks]].",
      "`[[Not a link]]` and \\[[escaped]]",
      "```",
      "[[Inside a fence]]",
      "```",
      "[[  Spaced   out  ]] and [[]] and [[ ]]",
    ].join("\n");
    const links = parseLinks(content);
    assert.deepEqual(
      links.map((link) => ({ target: link.target, title: link.title, heading: link.heading, label: link.label })),
      [
        { target: "Northwind MSA redlines", title: "Northwind MSA redlines", heading: null, label: null },
        { target: "Q4 plan#Risks", title: "Q4 plan", heading: "Risks", label: "the risks" },
        { target: "Spaced out", title: "Spaced out", heading: null, label: null },
      ],
    );
    assert.equal(content.slice(links[0].start, links[0].end), "[[Northwind MSA redlines]]");
  });

  it("keeps fences open until a matching close and ignores inline code across paragraphs", () => {
    const masked = maskCode("~~~\n[[a]]\n```\n[[b]]\n~~~\n[[c]] `x\n\ny` [[d]]");
    assert.deepEqual(
      parseLinks("~~~\n[[a]]\n```\n[[b]]\n~~~\n[[c]] `x\n\ny` [[d]]", masked).map((link) => link.target),
      ["c", "d"],
    );
  });

  it("rewrites links on rename, keeping headings and labels, case-insensitively, but not in code", () => {
    const content = "[[acme pricing]] and [[Acme Pricing#Tiers|tiers]] and `[[Acme pricing]]` and [[Acme pricing notes]]";
    const result = rewriteLinkTitle(content, "Acme pricing", "Acme pricing 2027");
    assert.equal(result.count, 2);
    assert.equal(result.content, "[[Acme pricing 2027]] and [[Acme pricing 2027#Tiers|tiers]] and `[[Acme pricing]]` and [[Acme pricing notes]]");
  });

  it("reads @ record mentions once each, outside code", () => {
    const content = `Call with @[Acme](company:${ACME}) and @[Lena Ortiz](contact:${LENA}). Again @[Acme](company:${ACME}). \`@[Hidden](company:${LENA})\``;
    assert.deepEqual(parseMentions(content), [
      { kind: "company", id: ACME, name: "Acme" },
      { kind: "contact", id: LENA, name: "Lena Ortiz" },
    ]);
  });
});

describe("doc tags", () => {
  it("reads inline and nested tags, lowercased and unique", () => {
    assert.deepEqual(parseTags("Plan #partners/q4 for #Clients/Acme and #clients/acme, #follow-up_now."), ["partners/q4", "clients/acme", "follow-up_now"]);
  });

  it("ignores headings, code, numbers, links, anchors and escapes", () => {
    const content = [
      "# Heading",
      "## Second ## ",
      "###### Six",
      "#Real at line start",
      "Issue #123 and #2026 are numbers",
      "A url https://x.test/#anchor and [link](#section) and mid#word",
      "`#code` and \\#escaped",
      "```",
      "#fenced",
      "```",
      "    #indented-still-counts",
      "[[Note #inside]] and @[Name #x](company:" + ACME + ")",
      "## Plan #q4",
    ].join("\n");
    assert.deepEqual(parseTags(content), ["real", "indented-still-counts", "q4"]);
  });

  it("trims slashes and rejects bad tags", () => {
    assert.equal(normaliseTag("#/clients//acme/"), "clients/acme");
    assert.equal(normaliseTag("#123"), null);
    assert.equal(normaliseTag("bad tag"), null);
    assert.equal(normaliseTag("#" + "a".repeat(101)), null);
    assert.deepEqual(parseTags("#émile and #日本"), ["émile", "日本"]);
  });

  it("parses everything in one pass", () => {
    const parsed = parseDoc(`[[A]] #t @[Acme](company:${ACME})`);
    assert.equal(parsed.links.length, 1);
    assert.deepEqual(parsed.tags, ["t"]);
    assert.equal(parsed.mentions[0].id, ACME);
  });
});

describe("doc edits", () => {
  it("appends with a blank line, or a single newline between list items", () => {
    assert.equal(appendText("First", "Second"), "First\n\nSecond");
    assert.equal(appendText("- one\n", "- two"), "- one\n- two");
    assert.equal(appendText("", "Only"), "Only");
  });

  it("finds and replaces once, refusing missing or ambiguous text", () => {
    assert.equal(findAndReplace("early December, early", "early December", "12 December"), "12 December, early");
    assert.throws(() => findAndReplace("abc", "zzz", "y"), /isn't in the doc/);
    assert.throws(() => findAndReplace("a a", "a", "b"), /appears 2 times/);
    assert.equal(findAndReplace("a a", "a", "b", true), "b b");
  });

  it("adds tags on a tag line and removes them inline", () => {
    assert.equal(retag("Body", ["clients/acme", "#Q4"], []), "Body\n\n#clients/acme #q4");
    assert.equal(retag("Body\n\n#a", ["b"], []), "Body\n\n#a #b");
    assert.equal(retag("Body #a here\n\n#b", [], ["a", "b"]), "Body here");
    assert.equal(retag("Body #a", ["a"], []), "Body #a");
    assert.throws(() => retag("x", ["no spaces allowed"], []), /isn't a tag/);
    assert.equal(applyDocEdit("x", { action: "replace", content: "y" }), "y");
  });
});

describe("doc diffs", () => {
  it("shows changed lines with a little context and gaps", () => {
    const before = ["## Q4 plan", "- [ ] Share pricing", "a", "b", "c", "d", "e", "## Risks", "Legal could slip."].join("\n");
    const after = ["## Q4 plan", "- [x] Share pricing", "a", "b", "c", "d", "e", "## Risks", "Legal could slip.", "Acme renews in January."].join("\n");
    const diff = lineDiff(before, after, { context: 1 });
    assert.deepEqual(diff, [
      { kind: "same", text: "## Q4 plan" },
      { kind: "remove", text: "- [ ] Share pricing" },
      { kind: "add", text: "- [x] Share pricing" },
      { kind: "same", text: "a" },
      { kind: "gap", text: "" },
      { kind: "same", text: "Legal could slip." },
      { kind: "add", text: "Acme renews in January." },
    ]);
    assert.deepEqual(diffCounts(diff), { added: 2, removed: 1 });
    assert.deepEqual(lineDiff("", "new"), [{ kind: "add", text: "new" }]);
  });
});

describe("daily notes format", () => {
  it("appends timed entries and reads them back", () => {
    let content = appendDailyEntry("", "08:42", "Slept badly. Coffee first.");
    content = appendDailyEntry(content, "16:48", "- [ ] Send Lena the dates\n- [x] Reply to Dana");
    assert.equal(content, "08:42 Slept badly. Coffee first.\n\n16:48 - [ ] Send Lena the dates\n- [x] Reply to Dana");
    assert.deepEqual(parseDailyEntries(content), [
      { time: "08:42", text: "Slept badly. Coffee first." },
      { time: "16:48", text: "- [ ] Send Lena the dates\n- [x] Reply to Dana" },
    ]);
  });

  it("uses the London date", () => {
    assert.equal(localDate(new Date("2026-10-28T23:30:00Z")), "2026-10-28");
    assert.equal(localDate(new Date("2026-07-01T23:30:00Z")), "2026-07-02");
    assert.equal(shiftDate("2026-03-01", -1), "2026-02-28");
    assert.ok(isDailyDate("2026-10-29"));
    assert.ok(!isDailyDate("2026-02-30"));
  });

  it("counts words and writes excerpts without markdown", () => {
    assert.equal(wordCount(`## Plan\n- [ ] Ship it with @[Acme](company:${ACME}) and [[Q4 plan|the plan]]`), 8);
    assert.equal(excerptFrom("# Title\n**Bold** and _it_"), "Title Bold and it");
  });
});
