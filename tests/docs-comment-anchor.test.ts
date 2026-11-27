import "./svg-stub";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicNote } from "@/components/docs/static-note";
import {
  ANCHOR_CONTEXT,
  ANCHOR_QUOTE_LIMIT,
  createAnchor,
  flattenText,
  locateOffset,
  offsetOf,
  resolveAnchor,
  stackCards,
  type CommentAnchor,
  type TextSegment,
} from "@/lib/docs/comment-anchor";

const VOID = new Set(["br", "input", "img", "hr", "meta", "link"]);
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

function decode(value: string) {
  return value.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => ENTITIES[entity]);
}

function segmentsOfHtml(html: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const stack: { tag: string; hidden: boolean; key: number | null }[] = [];
  let nextKey = 0;
  for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("<!")) continue;
    if (token.startsWith("</")) {
      stack.pop();
      continue;
    }
    if (token.startsWith("<")) {
      const tag = /^<([a-z0-9]+)/.exec(token)?.[1] ?? "";
      const blockStart = /data-line=/.test(token) || /class="[^"]*note-table-cell/.test(token);
      const parent = stack[stack.length - 1];
      const entry = {
        tag,
        hidden: Boolean(parent?.hidden) || /aria-hidden/.test(token),
        key: blockStart ? nextKey++ : (parent?.key ?? null),
      };
      if (!VOID.has(tag) && !token.endsWith("/>")) stack.push(entry);
      continue;
    }
    const top = stack[stack.length - 1];
    if (!top || top.hidden || top.key === null) continue;
    segments.push({ key: top.key, text: decode(token) });
  }
  return segments;
}

function flatOf(markdown: string) {
  return flattenText(segmentsOfHtml(renderToStaticMarkup(createElement(PublicNote, { body: markdown }))));
}

const SAMPLE = [
  "# Plan for the parcel",
  "",
  "We will recieve the parcel on Friday and check it.",
  "",
  "- First item with **bold** words",
  "- Second item links to [Orbit](https://example.com/page)",
  "",
  "1. Count the boxes",
  "2. Sign the form",
  "",
  "| Name | Amount |",
  "| --- | --- |",
  "| Apples | 12 |",
  "| Pears | 7 |",
  "",
  "- [ ] Open task",
  "- [x] Done task",
  "",
  "> A quoted line",
  "",
  "```ts",
  "const total = 1;",
  "```",
].join("\n");

describe("flattening rendered text", () => {
  const flat = flatOf(SAMPLE);

  it("reads headings, paragraphs and styled text as the page shows them", () => {
    assert.ok(flat.text.includes("Plan for the parcel\nWe will recieve the parcel on Friday and check it."));
    assert.ok(flat.text.includes("First item with bold words"));
    assert.ok(flat.text.includes("Second item links to Orbit"));
  });

  it("leaves out bullets, numbers and checkbox widgets", () => {
    assert.ok(flat.text.includes("First item with bold words\nSecond item links to Orbit\n"));
    assert.ok(flat.text.includes("Count the boxes\nSign the form"));
    assert.ok(!/(^|\n)1\./.test(flat.text));
    assert.ok(flat.text.includes("Open task\nDone task"));
  });

  it("keeps each table cell on its own line", () => {
    assert.ok(flat.text.includes("Name\nAmount\nApples\n12\nPears\n7"));
  });

  it("keeps code lines and quotes", () => {
    assert.ok(flat.text.includes("const total = 1;"));
    assert.ok(flat.text.includes("A quoted line"));
  });

  it("never starts or ends with a break and has no blank lines", () => {
    assert.ok(!flat.text.startsWith("\n"));
    assert.ok(!flat.text.endsWith("\n"));
    assert.ok(!flat.text.includes("\n\n"));
  });

  it("maps offsets to segments and back", () => {
    const at = flat.text.indexOf("Friday");
    const spot = locateOffset(flat, at);
    assert.ok(spot);
    assert.equal(offsetOf(flat, spot.segment, spot.offset), at);
    const end = flat.text.length;
    const last = locateOffset(flat, end);
    assert.ok(last);
    assert.equal(offsetOf(flat, last.segment, last.offset), end);
    assert.equal(locateOffset(flattenText([]), 0), null);
  });

  it("starts a range in the next block and ends one in the previous block at a boundary", () => {
    const result = flattenText([
      { key: 1, text: "abc" },
      { key: 2, text: "def" },
    ]);
    assert.deepEqual(locateOffset(result, 3, "before"), { segment: 0, offset: 3 });
    assert.deepEqual(locateOffset(result, 3, "after"), { segment: 1, offset: 0 });
    assert.deepEqual(locateOffset(result, 4, "after"), { segment: 1, offset: 0 });
    assert.deepEqual(locateOffset(result, 7, "after"), { segment: 1, offset: 3 });
    assert.deepEqual(locateOffset(result, 0, "after"), { segment: 0, offset: 0 });
  });

  it("joins segments of one block without a break and separates blocks", () => {
    const result = flattenText([
      { key: 1, text: "ab" },
      { key: 1, text: "cd" },
      { key: 2, text: "" },
      { key: 3, text: "ef" },
    ]);
    assert.equal(result.text, "abcd\nef");
  });
});

describe("creating anchors", () => {
  const text = "The quick brown fox jumps over the lazy dog. The quick brown fox sleeps.";

  it("keeps the quote with context either side", () => {
    const start = text.indexOf("jumps");
    const anchor = createAnchor(text, start, start + 5);
    assert.deepEqual(anchor, { quote: "jumps", prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT), start), suffix: text.slice(start + 5, start + 5 + ANCHOR_CONTEXT), at: start });
  });

  it("clips context at the ends of the text", () => {
    const anchor = createAnchor(text, 0, 3);
    assert.equal(anchor?.prefix, "");
    const tail = createAnchor(text, text.length - 7, text.length);
    assert.equal(tail?.suffix, "");
  });

  it("accepts a backwards range and refuses blank selections", () => {
    assert.equal(createAnchor(text, 9, 4)?.quote, "quick");
    assert.equal(createAnchor(text, 3, 4), null);
    assert.equal(createAnchor(text, 5, 5), null);
  });

  it("caps the quote and never cuts a surrogate pair", () => {
    const long = `${"a".repeat(ANCHOR_QUOTE_LIMIT - 1)}😀${"b".repeat(50)}`;
    const anchor = createAnchor(long, 0, long.length);
    assert.ok(anchor);
    assert.equal(anchor.quote.length, ANCHOR_QUOTE_LIMIT - 1);
    assert.ok(anchor.suffix.startsWith("😀"));
    assert.ok(JSON.stringify(anchor).length < 4000);
  });

  it("never leaves a lone surrogate in any anchor field", () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    const text = "😀".repeat(40) + " plain words in the middle " + "🎉x".repeat(40) + "😀".repeat(ANCHOR_QUOTE_LIMIT);
    for (let start = 0; start < 200; start += 1) {
      for (const length of [1, 2, 3, 31, 32, 33, 64, 65, ANCHOR_QUOTE_LIMIT - 1, ANCHOR_QUOTE_LIMIT, ANCHOR_QUOTE_LIMIT + 1]) {
        const anchor = createAnchor(text, start, start + length);
        if (!anchor) continue;
        for (const field of [anchor.quote, anchor.prefix, anchor.suffix]) assert.ok(!lone.test(field), `lone surrogate at ${start}+${length}`);
        assert.ok(anchor.quote.length > 0 && anchor.quote.length <= ANCHOR_QUOTE_LIMIT);
      }
    }
  });

  it("anchors a whole table and a whole list item from real markup", () => {
    const flat = flatOf(SAMPLE);
    const from = flat.text.indexOf("Name\nAmount");
    const to = flat.text.indexOf("7", from) + 1;
    const table = createAnchor(flat.text, from, to);
    assert.equal(table?.quote, "Name\nAmount\nApples\n12\nPears\n7");
    const itemStart = flat.text.indexOf("Count the boxes");
    const item = createAnchor(flat.text, itemStart, itemStart + "Count the boxes".length);
    assert.equal(item?.quote, "Count the boxes");
  });
});

describe("resolving anchors", () => {
  function anchorFor(text: string, quote: string, occurrence = 0) {
    let start = -1;
    for (let index = 0; index <= occurrence; index += 1) start = text.indexOf(quote, start + 1);
    const anchor = createAnchor(text, start, start + quote.length);
    assert.ok(anchor);
    return { anchor, start };
  }

  function found(text: string, anchor: CommentAnchor) {
    const result = resolveAnchor(text, anchor);
    assert.equal(result.status, "found");
    if (result.status !== "found") throw new Error("not found");
    return result;
  }

  it("finds an unchanged quote exactly", () => {
    const flat = flatOf(SAMPLE);
    const { anchor, start } = anchorFor(flat.text, "parcel on Friday");
    const result = found(flat.text, anchor);
    assert.deepEqual([result.start, result.end, result.fuzzy], [start, start + "parcel on Friday".length, false]);
  });

  it("picks the repeated quote whose context matches", () => {
    const text = "Send the form on Monday. Then send the form on Tuesday. Finally send the form on Friday.";
    const { anchor, start } = anchorFor(text, "the form", 1);
    assert.equal(found(text, anchor).start, start);
    const moved = `Intro line.\n${text}`;
    assert.equal(found(moved, anchor).start, start + "Intro line.\n".length);
  });

  it("falls back to position when repeated quotes have identical context", () => {
    const text = "abc dog xyz\nabc dog xyz\nabc dog xyz";
    const { anchor, start } = anchorFor(text, "dog", 2);
    assert.equal(found(text, anchor).start, start);
  });

  it("follows text that moved", () => {
    const text = "Alpha paragraph here.\nThe delivery arrives on Friday afternoon.\nOmega paragraph.";
    const { anchor } = anchorFor(text, "delivery arrives on Friday");
    const moved = "Omega paragraph.\nA new line in the middle.\nThe delivery arrives on Friday afternoon.\nAlpha paragraph here.";
    const result = found(moved, anchor);
    assert.equal(moved.slice(result.start, result.end), "delivery arrives on Friday");
  });

  it("keeps a comment on a corrected typo", () => {
    const flat = flatOf(SAMPLE);
    const { anchor } = anchorFor(flat.text, "recieve");
    const fixed = flatOf(SAMPLE.replace("recieve", "receive"));
    const result = found(fixed.text, anchor);
    assert.equal(fixed.text.slice(result.start, result.end), "receive");
    assert.equal(result.fuzzy, true);
  });

  it("keeps a comment when a word in the quote changes", () => {
    const text = "Our pricing is simple and the team agrees with it entirely today.";
    const { anchor } = anchorFor(text, "pricing is simple and the team agrees");
    const edited = "Our pricing is simple and the squad agrees with it entirely today.";
    const result = found(edited, anchor);
    assert.ok(edited.slice(result.start, result.end).includes("squad"));
  });

  it("keeps a comment when the surrounding text changed but the quote did not", () => {
    const text = "Before the change we said hello to the whole room.";
    const { anchor } = anchorFor(text, "said hello to the whole room");
    const edited = "A totally different opening: said hello to the whole room, again.";
    const result = found(edited, anchor);
    assert.equal(edited.slice(result.start, result.end), "said hello to the whole room");
  });

  it("orphans a comment when one side of the context and the quote both changed", () => {
    const text = "We expect the quartely results to arrive soon after the board meeting ends.";
    const { anchor } = anchorFor(text, "quartely results to arrive");
    const edited = "Rewritten opening, then the quarterly results to arrive soon after the board meeting ends.";
    assert.deepEqual(resolveAnchor(edited, anchor), { status: "orphaned" });
  });

  it("orphans a comment whose text was deleted", () => {
    const text = "Keep this line.\nThe budget needs another review before launch.\nKeep this too.";
    const { anchor } = anchorFor(text, "budget needs another review before launch");
    assert.deepEqual(resolveAnchor("Keep this line.\nKeep this too.", anchor), { status: "orphaned" });
  });

  it("does not attach deleted text to similar text with different surroundings", () => {
    const text = "Intro line.\nPlease send the contract to legal before Friday.\nOutro line.";
    const { anchor } = anchorFor(text, "send the contract to legal");
    const elsewhere = "Intro line.\nOutro line.\nSeparately we send the contract to the client on Monday.";
    assert.deepEqual(resolveAnchor(elsewhere, anchor), { status: "orphaned" });
    const same = "Intro line.\nOutro line.\nQuite different: send the contract to legal, eventually, maybe.";
    assert.equal(resolveAnchor(same, anchor).status, "found");
  });

  it("does not move a short quote to another copy of it after its line is deleted", () => {
    const text = "Fill in the form carefully now.\nSomething else entirely here.\nWe store the form in a drawer.";
    const { anchor } = anchorFor(text, "the form");
    assert.deepEqual(resolveAnchor("Something else entirely here.\nWe store the form in a drawer.", anchor), { status: "orphaned" });
  });

  it("only accepts an approximate match whose surroundings still match", () => {
    const text = "Opening paragraph about nothing much.\nThe committee will recieve the proposal tomorrow morning at ten.\nClosing words.";
    const { anchor } = anchorFor(text, "will recieve the proposal tomorrow");
    const fixed = text.replace("recieve", "receive");
    const kept = resolveAnchor(fixed, anchor);
    assert.equal(kept.status, "found");
    const moved = "Other opening.\nA new place: will receive the proposal tomorrow, they said.\nOther closing.";
    assert.deepEqual(resolveAnchor(moved, anchor), { status: "orphaned" });
  });

  it("deleting a block never moves its comment to the next similar block", () => {
    const legal = "Notes.\nAction: send the contract to legal by Friday.\nAction: send the contract to sales by Monday.\nEnd.";
    const first = anchorFor(legal, "Action: send the contract to legal by Friday.");
    assert.deepEqual(resolveAnchor("Notes.\nAction: send the contract to sales by Monday.\nEnd.", first.anchor), { status: "orphaned" });
    const calls = "Call Alice\nCall Bob\nCall Carl about the invoice";
    const bob = anchorFor(calls, "Call Bob");
    assert.deepEqual(resolveAnchor("Call Alice\nCall Carl about the invoice", bob.anchor), { status: "orphaned" });
  });

  it("keeps a typo fix attached in a one-block doc with no context", () => {
    const single = createAnchor("recieve the parcel", 0, 18);
    assert.ok(single);
    const result = found("receive the parcel", single);
    assert.equal(result.fuzzy, true);
    assert.equal(result.start, 0);
  });

  it("keeps typo fixes at the start and end of a block attached", () => {
    const text = "Intro paragraph here.\nrecieve the parcel on Friday morning please\nClosing paragraph here.";
    const start = anchorFor(text, "recieve the parcel on Friday");
    const fixedStart = text.replace("recieve", "receive");
    const startMatch = found(fixedStart, start.anchor);
    assert.ok(fixedStart.slice(startMatch.start, startMatch.end).startsWith("receive"));
    const endText = "Intro paragraph here.\nPlease check the parcel on Friday recieve\nClosing paragraph here.";
    const end = anchorFor(endText, "check the parcel on Friday recieve");
    const fixedEnd = endText.replace("recieve", "receive");
    const endMatch = found(fixedEnd, end.anchor);
    assert.ok(fixedEnd.slice(endMatch.start, endMatch.end).endsWith("receive"));
  });

  it("orphans a comment whose text was rewritten completely", () => {
    const text = "Opening words.\nThe budget needs another review before launch.\nClosing words.";
    const { anchor } = anchorFor(text, "budget needs another review before launch");
    assert.deepEqual(resolveAnchor("Something else entirely.\nNothing alike here.\nZ.", anchor), { status: "orphaned" });
  });

  it("does not attach a short quote to an unrelated word", () => {
    const text = "Please sign the form here before you leave today.";
    const { anchor } = anchorFor(text, "sign");
    assert.deepEqual(resolveAnchor("A design for another page with no verbs near it.", anchor), { status: "orphaned" });
  });

  it("anchors at the very start and end of a doc", () => {
    const text = "Start of the doc with some words and the end of the doc";
    const first = anchorFor(text, "Start of the doc");
    assert.equal(found(text, first.anchor).start, 0);
    const last = anchorFor(text, "end of the doc");
    assert.equal(found(`New first line.\n${text}`, last.anchor).end, text.length + "New first line.\n".length);
  });

  it("finds an end-of-doc quote after a typo fix with no suffix", () => {
    const text = "Intro here.\nThe last line has a mispelling";
    const { anchor } = anchorFor(text, "mispelling");
    const edited = "Intro here.\nThe last line has a misspelling";
    const result = found(edited, anchor);
    assert.equal(edited.slice(result.start, result.end), "misspelling");
  });

  it("returns orphaned for an empty quote", () => {
    assert.deepEqual(resolveAnchor("anything", { quote: "", prefix: "", suffix: "", at: 0 }), { status: "orphaned" });
  });

  it("handles tables, lists and headings from real markup after edits", () => {
    const flat = flatOf(SAMPLE);
    const cell = anchorFor(flat.text, "Apples");
    const edited = flatOf(SAMPLE.replace("| Apples | 12 |", "| Green apples | 12 |").replace("# Plan for the parcel", "# Plan"));
    const table = found(edited.text, cell.anchor);
    assert.ok(edited.text.slice(table.start, table.end).includes("apples"));
    const heading = anchorFor(flat.text, "Plan for the parcel");
    assert.equal(resolveAnchor(edited.text, heading.anchor).status === "found" || resolveAnchor(edited.text, heading.anchor).status === "orphaned", true);
    const item = anchorFor(flat.text, "Sign the form");
    const reordered = flatOf(SAMPLE.replace("1. Count the boxes\n2. Sign the form", "1. Sign the form\n2. Count the boxes"));
    const moved = found(reordered.text, item.anchor);
    assert.equal(reordered.text.slice(moved.start, moved.end), "Sign the form");
  });

  it("stays quick on a large document", () => {
    const filler = Array.from({ length: 4000 }, (_, index) => `Line number ${index} with some filler words.`).join("\n");
    const text = `${filler}\nThe unique sentence about forecasts sits here.\n${filler}`;
    const { anchor } = anchorFor(text, "unique sentence about forecasts");
    const edited = text.replace("forecasts", "forecastz");
    const began = Date.now();
    const result = found(edited, anchor);
    assert.ok(Date.now() - began < 3000);
    assert.ok(edited.slice(result.start, result.end).includes("forecastz"));
  });
});

describe("stacking cards", () => {
  const slots = (...tops: number[]) => tops.map((top, index) => ({ key: `c${index}`, top, height: 100 }));

  it("leaves cards where they are when nothing collides", () => {
    const result = stackCards(slots(0, 200, 500), 8);
    assert.deepEqual([...result.values()], [0, 200, 500]);
  });

  it("pushes colliding cards down in order", () => {
    const result = stackCards(slots(10, 20, 30), 8);
    assert.deepEqual([...result.values()], [10, 118, 226]);
  });

  it("never moves a card above the top of the margin", () => {
    const result = stackCards(slots(-40, -10), 8);
    assert.deepEqual([...result.values()], [0, 108]);
  });

  it("puts the active card at its own text and moves earlier cards up", () => {
    const result = stackCards(slots(100, 110, 120), 8, "c1");
    assert.equal(result.get("c1"), 110);
    assert.equal(result.get("c0"), 2);
    assert.equal(result.get("c2"), 218);
  });

  it("keeps the order and the gap when the active card is near the top", () => {
    const result = stackCards(slots(0, 20), 8, "c1");
    assert.equal(result.get("c0"), 0);
    assert.equal(result.get("c1"), 108);
  });

  it("handles no cards", () => {
    assert.equal(stackCards([], 8).size, 0);
  });
});
