import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MessageBody from "@/components/chat/message-body";
import { applyEdit, encodeChatMentions, formatEdit, mentionEdit } from "@/lib/chat/compose";
import { cleanFormat, formatMentions, formatsAt, insideCodeFence, markdownMarks, parseMarkdown } from "@/lib/chat/markdown";
import { stripMention } from "@/lib/task-pad";
import { physicalComboMatches, SHORTCUT_BY_ID } from "@/lib/shortcuts";

const SAM = "33333333-3333-4333-8333-333333333333";
const PRIYA = "44444444-4444-4444-8444-444444444444";
const ME = "22222222-2222-4222-8222-222222222222";
const sam = `@[Sam Okafor](member:${SAM})`;
const priya = `@[Priya Nair](member:${PRIYA})`;

function html(body: string, format: "plain" | "markdown" = "markdown") {
  return renderToStaticMarkup(createElement(MessageBody, { body, format, viewerId: ME }));
}

function inner(markup: string) {
  return markup.replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "");
}

function ids(body: string, format: "plain" | "markdown" = "markdown") {
  return formatMentions(body, format).map((mention) => mention.id);
}

describe("chat Markdown", () => {
  it("renders bold, italic, strikethrough and their nesting", () => {
    const markup = html("**bold _and italic_** then *star* and ~~gone~~");
    assert.match(markup, /<strong class="font-semibold">bold <em>and italic<\/em><\/strong>/);
    assert.match(markup, /<em>star<\/em>/);
    assert.match(markup, /<s>gone<\/s>/);
    assert.match(html("_**both**_"), /<em><strong class="font-semibold">both<\/strong><\/em>/);
  });

  it("keeps mentions working inside formatting", () => {
    const markup = html(`**${sam} please** and _${priya}_`);
    assert.match(markup, /<strong class="font-semibold"><span class="[^"]*">@Sam Okafor<\/span> please<\/strong>/);
    assert.match(markup, /<em><span class="[^"]*">@Priya Nair<\/span><\/em>/);
    assert.deepEqual(ids(`**${sam}** and ~~${priya}~~`), [SAM, PRIYA]);
  });

  it("shows code literally, with @, ** and mention tokens left as text", () => {
    const inline = html(`Run \`@deploy **now** ${sam}\` please`);
    assert.match(inline, /<code[^>]*>@deploy \*\*now\*\* @Sam Okafor<\/code>/);
    assert.doesNotMatch(inline, /<strong/);
    const block = html(`\`\`\`\nconst a = "**x**";\n${priya}\n\`\`\``);
    assert.match(block, /<pre[^>]*>const a = &quot;\*\*x\*\*&quot;;\n@Priya Nair<\/pre>/);
    assert.deepEqual(ids(`\`${sam}\` and\n\`\`\`\n${priya}\n\`\`\``), []);
    assert.deepEqual(ids(`\`${sam}\``, "plain"), [SAM]);
  });

  it("drops a language name after the fence and runs an unclosed fence to the end", () => {
    assert.deepEqual(parseMarkdown("```json\n{\"a\": 1}\n```"), [{ type: "code", text: '{"a": 1}' }]);
    assert.deepEqual(parseMarkdown("```one line```"), [{ type: "code", text: "one line" }]);
    assert.deepEqual(parseMarkdown(`Here:\n\`\`\`\nnot closed ${sam}`), [
      { type: "paragraph", children: [{ type: "text", text: "Here:" }] },
      { type: "code", text: `not closed ${sam}` },
    ]);
    assert.deepEqual(ids(`\`\`\`\nnot closed ${sam}`), []);
    assert.equal(parseMarkdown(`\`\`\`not a fence ${sam}`)[0].type, "paragraph");
    assert.deepEqual(ids(`\`\`\`not a fence ${sam}`), [SAM]);
  });

  it("links URLs and Markdown links without italicising underscores in them", () => {
    const markup = html("See https://example.com/a_b_c_ and [the doc](https://example.com/x_y_z) or mail jo_smith@example.com");
    assert.match(markup, /<a href="https:\/\/example.com\/a_b_c_" target="_blank" rel="noopener noreferrer"[^>]*>https:\/\/example.com\/a_b_c_<\/a>/);
    assert.match(markup, /<a href="https:\/\/example.com\/x_y_z"[^>]*>the doc<\/a>/);
    assert.match(markup, /<a href="mailto:jo_smith@example.com"/);
    assert.doesNotMatch(markup, /<em>/);
  });

  it("refuses links that aren't web or mail addresses", () => {
    const markup = html("[click](javascript:alert(1)) [x](data:text/html,hi)");
    assert.doesNotMatch(markup, /href="javascript/);
    assert.doesNotMatch(markup, /href="data/);
  });

  it("treats underscores inside words as text", () => {
    assert.doesNotMatch(html("rename snake_case_name and __init__ and 5*3*2"), /<em>/);
    assert.match(html("an _italic_ word, (_this_ too)"), /an <em>italic<\/em> word, \(<em>this<\/em> too\)/);
  });

  it("leaves unclosed and empty markers as they were", () => {
    assert.equal(inner(html("**unclosed and *also _this")), "<div>**unclosed and *also _this</div>");
    assert.equal(inner(html("** spaced ** and ****")), "<div>** spaced ** and ****</div>");
    assert.equal(inner(html("2 * 3 * 4")), "<div>2 * 3 * 4</div>");
  });

  it("renders quotes and lists, and keeps headings, tables and HTML as text", () => {
    const markup = html("> quoted *line*\n> second\n- one\n- **two**\n3. three\n4. four\n# Not a heading\n| a | b |\n<b>no</b>");
    assert.match(markup, /<blockquote[^>]*>quoted <em>line<\/em>\nsecond<\/blockquote>/);
    assert.match(markup, /<ul[^>]*><li>one<\/li><li><strong class="font-semibold">two<\/strong><\/li><\/ul>/);
    assert.match(markup, /<ol start="3"[^>]*><li>three<\/li><li>four<\/li><\/ol>/);
    assert.match(markup, /# Not a heading\n\| a \| b \|\n&lt;b&gt;no&lt;\/b&gt;/);
    assert.doesNotMatch(markup, /<h1|<table|<b>/);
  });

  it("leaves plain messages as they were sent", () => {
    const markup = html(`**not bold** _nor this_ ${sam}`, "plain");
    assert.match(markup, /\*\*not bold\*\* _nor this_ <span/);
    assert.doesNotMatch(markup, /<strong|<em>/);
    assert.equal(cleanFormat("markdown"), "markdown");
    assert.equal(cleanFormat("html"), "plain");
    assert.equal(cleanFormat(undefined), "plain");
  });

  it("marks Markdown syntax for the composer without touching mentions", () => {
    const text = "**hi** `x` > no";
    assert.deepEqual(
      markdownMarks(text).map((mark) => text.slice(mark.start, mark.end)),
      ["**", "**", "`", "`"],
    );
    assert.deepEqual(
      markdownMarks("> yes\n```js\nx\n```").map((mark) => [mark.start, mark.end]),
      [
        [0, 1],
        [6, 9],
        [9, 11],
        [14, 17],
      ],
    );
  });

  it("knows when the caret is inside a code fence", () => {
    const text = "Here:\n```\n{ a: 1";
    assert.equal(insideCodeFence(text, text.length), true);
    assert.equal(insideCodeFence(text, 3), false);
    assert.equal(insideCodeFence(`${text}\n\`\`\`\nafter`, text.length + 8), false);
  });
});

describe("chat composer formatting", () => {
  function run(value: string, start: number, end: number, action: Parameters<typeof formatEdit>[3]) {
    const edit = formatEdit(value, start, end, action);
    const next = applyEdit(value, edit);
    return { next, selected: next.slice(edit.selectionStart, edit.selectionEnd), caret: edit.selectionStart };
  }

  it("wraps the selection and keeps it selected, and unwraps it again", () => {
    assert.deepEqual(run("make this bold", 5, 9, "bold"), { next: "make **this** bold", selected: "this", caret: 7 });
    assert.deepEqual(run("make **this** bold", 7, 11, "bold"), { next: "make this bold", selected: "this", caret: 5 });
    assert.deepEqual(run("a word ", 2, 7, "italic"), { next: "a _word_ ", selected: "word", caret: 3 });
    assert.equal(run("", 0, 0, "strike").next, "~~~~");
    assert.equal(run("", 0, 0, "strike").caret, 2);
  });

  it("makes links, lists, quotes and code", () => {
    assert.equal(run("see docs", 4, 8, "link").next, "see [docs](https://)");
    assert.equal(run("see docs", 4, 8, "link").caret, "see [docs](https://".length);
    assert.deepEqual(run("https://a.test", 0, 14, "link"), { next: "[https://a.test](https://a.test)", selected: "https://a.test", caret: 1 });
    assert.equal(run("one\ntwo", 0, 7, "bullets").next, "- one\n- two");
    assert.equal(run("- one\n- two", 0, 11, "bullets").next, "one\ntwo");
    assert.equal(run("one\ntwo", 1, 5, "numbers").next, "1. one\n2. two");
    assert.equal(run("intro\nsaid this", 8, 8, "quote").next, "intro\n> said this");
    assert.equal(run("call x()", 5, 8, "code").next, "call `x()`");
    assert.equal(run("a\nb", 0, 3, "code").next, "```\na\nb\n```");
    assert.equal(run("before", 6, 6, "codeBlock").next, "before\n```\n\n```");
  });

  it("starts a mention with a space when it follows a word", () => {
    assert.equal(applyEdit("hi", mentionEdit("hi", 2, 2)), "hi @");
    assert.equal(applyEdit("hi ", mentionEdit("hi ", 3, 3)), "hi @");
  });

  it("matches the formatting keys by physical key, so ⌘⇧7 works on any layout", () => {
    const numbers = SHORTCUT_BY_ID.get("chat-numbers")!.combos![0];
    const event = { key: "&", code: "Digit7", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true };
    assert.equal(physicalComboMatches(numbers, event, true), true);
    assert.equal(physicalComboMatches(numbers, { ...event, shiftKey: false }, true), false);
    assert.equal(physicalComboMatches(numbers, { ...event, metaKey: false, ctrlKey: true }, false), true);
    const link = SHORTCUT_BY_ID.get("chat-link")!.combos![0];
    assert.equal(physicalComboMatches(link, { key: "k", code: "KeyK", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, true), true);
    for (const id of ["chat-bold", "chat-italic", "chat-strike", "chat-link", "chat-code", "chat-numbers", "chat-bullets", "chat-quote", "chat-send-code"]) {
      assert.equal(SHORTCUT_BY_ID.get(id)?.group, "Chat", id);
    }
  });
});

describe("chat Markdown review fixes", () => {
  function linksIn(markup: string) {
    return [...markup.matchAll(/<a href="([^"]*)"/g)].map((match) => match[1]);
  }

  it("keeps every emphasis marker out of a bare URL or a link next to it", () => {
    for (const [marker, tag] of [
      ["**", "strong"],
      ["_", "em"],
      ["*", "em"],
      ["~~", "s"],
    ] as const) {
      for (const inside of ["https://x.com/path", "see https://x.com", "[docs](https://x.com/a_b)"]) {
        const markup = html(`${marker}${inside}${marker} after`);
        assert.match(markup, new RegExp(`<${tag}[^>]*>`), `${marker}${inside}${marker}`);
        for (const href of linksIn(markup)) assert.doesNotMatch(href, /[*~]|_$/, `${marker}${inside}${marker} gave ${href}`);
        assert.ok(!markup.includes(`${marker} after`), `${marker}${inside}${marker} left a marker`);
      }
    }
    assert.deepEqual(linksIn(html("https://x.com/a** and https://y.com~~")), ["https://x.com/a", "https://y.com"]);
  });

  it("never puts a link inside a link", () => {
    for (const body of ["[https://bank.com](https://evil.example)", "[mail jo@x.com](https://x.com)", "[**https://a.com**](https://b.com)"]) {
      const markup = html(body);
      assert.equal(linksIn(markup).length, 1, body);
      assert.doesNotMatch(markup, /<a [^>]*>(?:(?!<\/a>).)*<a /, body);
    }
    assert.match(html("[https://bank.com](https://evil.example)"), /<a href="https:\/\/evil.example"[^>]*>https:\/\/bank.com<\/a>/);
  });

  it("reads ***both*** as bold italic and links with one level of brackets", () => {
    assert.match(html("***both*** ok"), /<strong class="font-semibold"><em>both<\/em><\/strong> ok/);
    assert.deepEqual(linksIn(html("[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet)) is hot")), ["https://en.wikipedia.org/wiki/Mercury_(planet)"]);
  });

  it("only treats ``` at the start of a line as a fence", () => {
    assert.equal(insideCodeFence("use ``` for code", 16), false);
    assert.equal(insideCodeFence("use ``` for code and ``` again", 30), false);
    assert.equal(insideCodeFence("```\ncode", 8), true);
    assert.equal(insideCodeFence("```\ncode\n```\nafter", 18), false);
  });

  it("knows which formats the caret is in", () => {
    const text = "**bold _it_** `c` [l](https://x.com)\n> q\n- a";
    assert.deepEqual([...formatsAt(text, 8)].sort(), ["bold", "italic"]);
    assert.deepEqual([...formatsAt(text, 15)], ["code"]);
    assert.deepEqual([...formatsAt(text, 20)], ["link"]);
    assert.deepEqual([...formatsAt(text, text.indexOf("q"))], ["quote"]);
    assert.deepEqual([...formatsAt(text, text.length)], ["bullets"]);
    assert.deepEqual([...formatsAt("```\nx\n```", 5)], ["codeBlock"]);
    assert.deepEqual([...formatsAt("```\nstill typing", 16)], ["codeBlock"]);
    assert.equal(formatsAt("```\nx\n```", 9).size, 0);
    assert.equal(formatsAt("plain", 2).size, 0);
  });

  it("encodes a tag outside code even when the same name appears in code first", () => {
    const sam = { kind: "member" as const, id: SAM, name: "Sam Okafor" };
    assert.equal(encodeChatMentions("`@Sam Okafor` then @Sam Okafor", [sam]), `\`@Sam Okafor\` then @[Sam Okafor](member:${SAM})`);
    assert.equal(encodeChatMentions("```\n@Sam Okafor\n```\n@Sam Okafor", [sam]), `\`\`\`\n@Sam Okafor\n\`\`\`\n@[Sam Okafor](member:${SAM})`);
    assert.equal(encodeChatMentions("`@Sam Okafor`", [sam]), "`@Sam Okafor`");
    const short = { kind: "member" as const, id: PRIYA, name: "Sam" };
    assert.equal(encodeChatMentions("@Sam Okafor and @Sam", [sam, short]), `@[Sam Okafor](member:${SAM}) and @[Sam](member:${PRIYA})`);
  });
});

describe("chat composer review fixes", () => {
  function run(value: string, start: number, end: number, action: Parameters<typeof formatEdit>[3]) {
    const edit = formatEdit(value, start, end, action);
    const next = applyEdit(value, edit);
    return { next, selected: next.slice(edit.selectionStart, edit.selectionEnd), caret: edit.selectionStart };
  }

  it("wraps and unwraps each line of a multi-line selection", () => {
    for (const [action, marker] of [
      ["bold", "**"],
      ["italic", "_"],
      ["strike", "~~"],
    ] as const) {
      const wrapped = run("one\n\n two", 0, 9, action).next;
      assert.equal(wrapped, `${marker}one${marker}\n\n ${marker}two${marker}`);
      assert.equal(run(wrapped, 0, wrapped.length, action).next, "one\n\n two");
      assert.ok(parseMarkdown(wrapped).every((block) => block.type !== "paragraph" || block.children.every((node) => node.type !== "text" || !node.text.includes(marker))), action);
    }
  });

  it("keeps the caret where it was when a list or quote is added without a selection", () => {
    assert.deepEqual(run("first\nsecond line", 9, 9, "bullets"), { next: "first\n- second line", selected: "", caret: 11 });
    assert.deepEqual(run("first\n1. second", 12, 12, "numbers"), { next: "first\nsecond", selected: "", caret: 9 });
    assert.equal(run("say this", 3, 3, "quote").caret, 5);
  });

  it("unwraps a code block when the caret is already in one", () => {
    assert.deepEqual(run("before\n```\nline one\nline two\n```\nafter", 14, 14, "codeBlock"), { next: "before\nline one\nline two\nafter", selected: "line one\nline two", caret: 7 });
    assert.equal(run("```\nopen block", 8, 8, "codeBlock").next, "open block");
  });

  it("starts a mention right after an opening marker, and only there", () => {
    assert.equal(applyEdit("****", mentionEdit("****", 2, 2)), "**@**");
    assert.equal(applyEdit("_", mentionEdit("_", 1, 1)), "_@");
    assert.equal(applyEdit("word", mentionEdit("word", 4, 4)), "word @");
    assert.deepEqual(stripMention("**@ma**", 5, { afterMarkers: true }), { start: 2, end: 5, query: "ma" });
    assert.deepEqual(stripMention("hi _~@sa", 8, { afterMarkers: true }), { start: 5, end: 8, query: "sa" });
    assert.equal(stripMention("x**@ma", 6, { afterMarkers: true }), null);
    assert.equal(stripMention("**@ma", 5), null);
    assert.deepEqual(stripMention("Call @Ac", 8), { start: 5, end: 8, query: "Ac" });
  });
});
