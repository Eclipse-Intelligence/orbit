import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from "@codemirror/state";
import { formatsAt, markdownMarks, parseMarkdown, type Inline } from "@/lib/chat/markdown";
import {
  activeFormats,
  chatEditorExtensions,
  inlineToggle,
  lineStartBackspace,
  lineToggle,
  linkEdit,
  loadMarkdown,
  newline,
  reloadMarkdown,
  resetHistory,
  richDecorations,
  richDoc,
  stateMarkdown,
} from "@/lib/chat/rich-editor";
import { cleanHref, fromMarkdown, normalSpans, sameLook, sliceMarkdown, tightenAt, toMarkdown, type InlineKind, type InlineSpan } from "@/lib/chat/rich-text";

function editor(markdown: string) {
  const base = EditorState.create({ extensions: chatEditorExtensions() });
  return base.update(loadMarkdown(base, markdown)).state;
}

function apply(state: EditorState, spec: TransactionSpec) {
  return state.update(spec).state;
}

function select(state: EditorState, from: number, to = from) {
  return apply(state, { selection: EditorSelection.single(from, to) });
}

function type(state: EditorState, text: string) {
  let next = state;
  for (const char of text) {
    const range = next.selection.main;
    next = apply(next, { changes: { from: range.from, to: range.to, insert: char }, selection: EditorSelection.cursor(range.from + char.length), userEvent: "input.type" });
  }
  return next;
}

function backspace(state: EditorState) {
  const range = state.selection.main;
  const from = range.empty ? range.from - 1 : range.from;
  return apply(state, { changes: { from, to: range.to }, selection: EditorSelection.cursor(from), userEvent: "delete.backward" });
}

function shown(state: EditorState) {
  return state.doc.toString();
}

const MARKERS = /\*\*|~~|`|\]\(|^\s*[-*]\s|^\d+\.\s|^>|```/m;

const CORPUS = [
  "plain words",
  "hello **bold** and _italic_ and ~~gone~~ and `code`",
  "***both*** and *star italic* and __not__ here",
  "see [Acme](https://acme.test) and https://example.com/a_b_c",
  "- one\n- **two**\n- three",
  "1. first\n2. second\n\n3. later",
  "> a quote with **bold**\n>\n> more",
  "before\n```js\nconst a = 1;\n**not bold**\n```\nafter",
  "```\nunclosed fence",
  "@Sam Smith said **hi @Sam Smith**",
  "snake_case_name and 2 * 3 * 4",
  "**unclosed and `half",
  "**a** **b** ~~c~~d",
  "mixed **bold _and italic_ inside**",
  "",
  "\n\n",
  "line\n\n\nwith gaps",
];

describe("chat rich composer: what the box shows", () => {
  it("shows text without the Markdown markers the parser recognises", () => {
    for (const markdown of CORPUS) {
      const doc = fromMarkdown(markdown);
      const marks = markdownMarks(markdown).filter((mark) => !/^```/.test(markdown.slice(mark.start)));
      if (marks.length === 0 && !/^\s*(?:[-*•]|\d+\.|>)\s/m.test(markdown) && !markdown.includes("```")) {
        assert.equal(doc.text, markdown, markdown);
        continue;
      }
      if (!markdown.includes("```") && !markdown.includes("**unclosed") && !markdown.includes("__not__")) assert.doesNotMatch(doc.text, MARKERS, markdown);
    }
    assert.equal(fromMarkdown("hello **bold** and _it_").text, "hello bold and it");
    assert.equal(fromMarkdown("- one\n- two").text, "one\ntwo");
    assert.equal(fromMarkdown("> quoted").text, "quoted");
    assert.equal(fromMarkdown("[Acme](https://acme.test)").text, "Acme");
    assert.equal(fromMarkdown("```\nx\n```").text, "x");
    assert.equal(fromMarkdown("**unclosed").text, "**unclosed");
  });

  it("writes back Markdown that reads as the same formatted text", () => {
    for (const markdown of CORPUS) {
      const doc = fromMarkdown(markdown);
      const again = fromMarkdown(toMarkdown(doc));
      assert.ok(sameLook(doc, again), markdown);
      assert.equal(toMarkdown(again), toMarkdown(doc), markdown);
    }
  });

  it("keeps Markdown it already wrote exactly as it was", () => {
    for (const markdown of [
      "hello **bold** and _it_ ~~gone~~ `code` [Acme](https://acme.test) end",
      "- one\n- **two**\n\n1. a\n2. b",
      "3. x\n4. y",
      "> quoted **x**\n>\n> more",
      "before\n```js\nconst a = 1;\n\nb\n```\nafter",
    ]) {
      assert.equal(toMarkdown(fromMarkdown(markdown)), markdown);
    }
  });

  it("hides markers in the editor by keeping them out of the document", () => {
    const state = editor("say **hi** to [Acme](https://acme.test)\n- item");
    assert.equal(shown(state), "say hi to Acme\nitem");
    assert.equal(stateMarkdown(state), "say **hi** to [Acme](https://acme.test)\n- item");
    const classes: string[] = [];
    const cursor = richDecorations(state).iter();
    for (; cursor.value; cursor.next()) classes.push(`${cursor.value.spec.class}:${state.sliceDoc(cursor.from, cursor.to)}`);
    assert.ok(classes.includes("chat-strong:hi"));
    assert.ok(classes.includes("chat-link:Acme"));
    assert.ok(classes.some((item) => item.startsWith("chat-li chat-li-bullet")));
  });
});

describe("chat rich composer: typing", () => {
  it("continues bold after bold text, like Slack, across spaces", () => {
    let state = editor("**hi**");
    state = type(state, " there");
    assert.equal(stateMarkdown(state), "**hi there**");
    assert.equal(shown(state), "hi there");
  });

  it("turns bold on and off for what is typed next when nothing is selected", () => {
    let state = editor("say ");
    state = apply(state, inlineToggle(state, "bold"));
    assert.ok(activeFormats(state).has("bold"));
    state = type(state, "loud");
    state = apply(state, inlineToggle(state, "bold"));
    assert.ok(!activeFormats(state).has("bold"));
    state = type(state, " quiet");
    assert.equal(stateMarkdown(state), "say **loud** quiet");
    assert.equal(shown(state), "say loud quiet");
  });

  it("ends formatting in the middle of a word without breaking the rest", () => {
    let state = editor("**hello**");
    state = select(state, 3);
    state = apply(state, inlineToggle(state, "bold"));
    state = type(state, "X");
    assert.equal(shown(state), "helXlo");
    assert.equal(stateMarkdown(state), "**hel**X**lo**");
  });

  it("drops the markers with the last formatted character", () => {
    let state = editor("a **b** c");
    state = select(state, 3);
    state = backspace(state);
    assert.equal(shown(state), "a  c");
    assert.equal(stateMarkdown(state), "a  c");
  });

  it("keeps formatting when a word is replaced, as autocorrect and dictation do", () => {
    let state = editor("**teh plan**");
    state = apply(state, { changes: { from: 0, to: 3, insert: "the" }, userEvent: "input.type" });
    assert.equal(stateMarkdown(state), "**the plan**");
    state = editor("see [teh site](https://acme.test)");
    state = apply(state, { changes: { from: 4, to: 7, insert: "the" }, userEvent: "input" });
    assert.equal(stateMarkdown(state), "see [the site](https://acme.test)");
  });

  it("does not stretch a link over text typed after it", () => {
    let state = editor("[Acme](https://acme.test)");
    state = select(state, 4);
    state = type(state, " rocks");
    assert.equal(stateMarkdown(state), "[Acme](https://acme.test) rocks");
  });

  it("turns typed Markdown into formatting once the word ends", () => {
    let state = editor("");
    state = type(state, "**bold**");
    assert.equal(shown(state), "**bold**");
    state = type(state, " next");
    assert.equal(shown(state), "bold next");
    assert.equal(stateMarkdown(state), "**bold** next");
    state = editor("");
    state = type(state, "- ");
    assert.equal(shown(state), "");
    assert.equal(stateMarkdown(state), "- ");
    state = type(state, "item");
    assert.equal(stateMarkdown(state), "- item");
  });

  it("converts pasted Markdown at once", () => {
    let state = editor("");
    state = apply(state, { changes: { from: 0, insert: "> **quoted** line" }, selection: EditorSelection.cursor(17), userEvent: "input.paste" });
    assert.equal(shown(state), "quoted line");
    assert.equal(stateMarkdown(state), "> **quoted** line");
  });

  it("leaves text inside a code block alone", () => {
    let state = editor("```\nx\n```");
    state = select(state, 1);
    state = type(state, " **y** ");
    assert.equal(shown(state), "x **y** ");
    assert.equal(stateMarkdown(state), "```\nx **y** \n```");
  });

  it("tightens punctuation after a picked mention", () => {
    assert.equal(tightenAt("hi @Sam Smith ,", 14, ["Sam Smith"]), 13);
    assert.equal(tightenAt("hi Sam ,", 7, ["Sam Smith"]), -1);
    assert.equal(tightenAt("hi @Sam Smith x", 14, ["Sam Smith"]), -1);
  });
});

describe("chat rich composer: toolbar", () => {
  it("wraps and unwraps a selection", () => {
    let state = editor("make this strong");
    state = select(state, 5, 9);
    state = apply(state, inlineToggle(state, "bold"));
    assert.equal(stateMarkdown(state), "make **this** strong");
    assert.ok(activeFormats(state).has("bold"));
    state = apply(state, inlineToggle(state, "bold"));
    assert.equal(stateMarkdown(state), "make this strong");
    state = apply(state, inlineToggle(state, "italic"));
    state = apply(state, inlineToggle(state, "strike"));
    assert.equal(stateMarkdown(state), "make ~~_this_~~ strong");
    state = apply(state, inlineToggle(state, "code"));
    assert.equal(stateMarkdown(state), "make ~~_`this`_~~ strong");
  });

  it("keeps spaces at the edges of a selection outside the markers", () => {
    let state = editor("a big word");
    state = select(state, 1, 6);
    state = apply(state, inlineToggle(state, "bold"));
    assert.equal(stateMarkdown(state), "a **big** word");
  });

  it("skips italic it cannot write inside a word rather than showing underscores", () => {
    let state = editor("mid");
    state = select(state, 1, 2);
    state = apply(state, inlineToggle(state, "italic"));
    assert.equal(stateMarkdown(state), "mid");
    state = apply(state, inlineToggle(state, "bold"));
    assert.equal(stateMarkdown(state), "m**i**d");
  });

  it("toggles lists, quotes and code blocks on whole lines", () => {
    let state = editor("one\ntwo");
    state = select(state, 0, 7);
    state = apply(state, lineToggle(state, "bullets"));
    assert.equal(stateMarkdown(state), "- one\n- two");
    assert.ok(activeFormats(state).has("bullets"));
    state = apply(state, lineToggle(state, "numbers"));
    assert.equal(stateMarkdown(state), "1. one\n2. two");
    state = apply(state, lineToggle(state, "numbers"));
    assert.equal(stateMarkdown(state), "one\ntwo");
    state = apply(state, lineToggle(state, "quote"));
    assert.equal(stateMarkdown(state), "> one\n> two");
    state = apply(state, lineToggle(state, "code"));
    assert.equal(stateMarkdown(state), "```\none\ntwo\n```");
    assert.ok(activeFormats(state).has("codeBlock"));
  });

  it("turns a multi-line selection into a code block from the code button", () => {
    let state = editor("a\nb");
    state = select(state, 0, 3);
    state = apply(state, inlineToggle(state, "code"));
    assert.equal(stateMarkdown(state), "```\na\nb\n```");
  });

  it("adds, edits and removes links", () => {
    let state = editor("see site");
    state = apply(state, linkEdit(state, { from: 4, to: 8, href: "https://acme.test" }));
    assert.equal(stateMarkdown(state), "see [site](https://acme.test)");
    assert.ok(activeFormats(select(state, 6)).has("link"));
    state = apply(state, linkEdit(state, { from: 4, to: 8, href: "https://other.test" }));
    assert.equal(stateMarkdown(state), "see [site](https://other.test)");
    state = apply(state, linkEdit(state, { from: 4, to: 8, href: null }));
    assert.equal(stateMarkdown(state), "see site");
    state = apply(state, linkEdit(state, { from: 8, to: 8, href: "https://acme.test", text: " Acme" }));
    assert.equal(stateMarkdown(state), "see site [Acme](https://acme.test)");
  });

  it("cleans typed link addresses", () => {
    assert.equal(cleanHref("acme.test"), "https://acme.test");
    assert.equal(cleanHref("https://acme.test/a_(b)"), "https://acme.test/a_(b)");
    assert.equal(cleanHref("sam@acme.test"), "mailto:sam@acme.test");
    assert.equal(cleanHref("has space"), null);
    assert.equal(cleanHref("https://acme.test/a)"), null);
  });
});

describe("chat rich composer: lines", () => {
  it("continues a list on a new line and leaves it on an empty item", () => {
    let state = editor("- one");
    state = select(state, 3);
    state = apply(state, newline(state));
    state = type(state, "two");
    assert.equal(stateMarkdown(state), "- one\n- two");
    state = apply(state, newline(state));
    state = apply(state, newline(state));
    state = type(state, "after");
    assert.equal(stateMarkdown(state), "- one\n- two\nafter");
  });

  it("numbers a continued list", () => {
    let state = editor("1. one");
    state = select(state, 3);
    state = apply(state, newline(state));
    state = type(state, "two");
    assert.equal(stateMarkdown(state), "1. one\n2. two");
  });

  it("removes the bullet when backspacing at the start of an item", () => {
    let state = editor("- one");
    state = select(state, 0);
    const spec = lineStartBackspace(state);
    assert.ok(spec);
    state = apply(state, spec);
    assert.equal(stateMarkdown(state), "one");
    assert.equal(lineStartBackspace(state), null);
  });

  it("leaves a code block from its empty last line", () => {
    let state = editor("```\nx\n```");
    state = select(state, 1);
    state = apply(state, newline(state, { exitCode: true }));
    assert.equal(stateMarkdown(state), "```\nx\n\n```");
    state = apply(state, newline(state, { exitCode: true }));
    state = type(state, "after");
    assert.equal(stateMarkdown(state), "```\nx\n```\nafter");
  });

  it("does not carry a deleted list line onto the next line", () => {
    let state = editor("a\n- b\nc");
    state = apply(state, { changes: { from: 2, to: 4 }, userEvent: "delete" });
    assert.equal(stateMarkdown(state), "a\nc");
  });

  it("reports active formats the same way the message renders them", () => {
    const markdown = "say **hi** and _bye_";
    const state = editor(markdown);
    assert.deepEqual([...activeFormats(select(state, 6))], [...formatsAt(markdown, 7)]);
    assert.equal(parseMarkdown(stateMarkdown(state)).length, 1);
  });
});

describe("chat rich composer: undo", () => {
  function run(state: EditorState, command: typeof undo) {
    let next = state;
    command({ state, dispatch: (tr: Transaction) => (next = tr.state) });
    return next;
  }

  it("undoes a format change on its own and leaves loaded text out of the history", () => {
    let state = editor("make this strong");
    assert.equal(run(state, undo), state);
    state = select(state, 5, 9);
    state = apply(state, inlineToggle(state, "bold"));
    assert.equal(stateMarkdown(state), "make **this** strong");
    state = run(state, undo);
    assert.equal(stateMarkdown(state), "make this strong");
    state = run(state, redo);
    assert.equal(stateMarkdown(state), "make **this** strong");
  });
});

describe("chat rich composer: what you see is what is sent", () => {
  it("never shows anything different from the Markdown it sends, whatever is typed or toggled", () => {
    let seed = 7;
    const random = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    const inline = ["bold", "italic", "strike", "code"] as const;
    const blocks = ["bullets", "numbers", "quote", "code"] as const;
    const letters = "ab cd. e,f  gh";
    for (let round = 0; round < 80; round += 1) {
      let state = editor("");
      for (let move = 0; move < 40; move += 1) {
        const pick = random(10);
        const length = state.doc.length;
        if (pick < 5) state = type(state, letters[random(letters.length)]);
        else if (pick === 5) state = apply(state, inlineToggle(state, inline[random(inline.length)]));
        else if (pick === 6) state = apply(state, lineToggle(state, blocks[random(blocks.length)]));
        else if (pick === 7) state = apply(state, newline(state, { exitCode: random(2) === 0 }));
        else if (pick === 8 && length > 0) state = backspace(state);
        else {
          const from = random(length + 1);
          state = select(state, from, Math.min(length, from + random(5)));
        }
        const sent = fromMarkdown(stateMarkdown(state));
        assert.ok(sameLook(richDoc(state), sent), `round ${round} move ${move}: ${JSON.stringify(stateMarkdown(state))} shows ${JSON.stringify(shown(state))}`);
      }
    }
  });

  it("catches up with Markdown typed by hand once the word ends", () => {
    let seed = 11;
    const random = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    const keys = "ab*_~`->1.[]() ";
    for (let round = 0; round < 80; round += 1) {
      let state = editor("");
      for (let move = 0; move < 40; move += 1) {
        const pick = random(8);
        if (pick < 6) state = type(state, keys[random(keys.length)]);
        else if (pick === 6) state = apply(state, newline(state));
        else if (state.doc.length > 0) state = backspace(state);
        if (pick < 6) continue;
        state = type(state, " ");
        const sent = fromMarkdown(stateMarkdown(state));
        assert.ok(sameLook(richDoc(state), sent), `round ${round} move ${move}: ${JSON.stringify(stateMarkdown(state))} shows ${JSON.stringify(shown(state))}`);
      }
    }
  });
});

type Look = { text: string; formats: string[] };

function parsedLook(markdown: string): Look {
  const out: Look = { text: "", formats: [] };
  const push = (text: string, format: string[]) => {
    for (const char of text) {
      out.text += char;
      out.formats.push(/\s/.test(char) ? "" : [...format].sort().join(","));
    }
  };
  const walk = (nodes: Inline[], format: string[]) => {
    for (const node of nodes) {
      if (node.type === "text") push(node.text, format);
      else if (node.type === "url") push(node.text, format);
      else if (node.type === "code") push(node.text, [...format, "code"]);
      else if (node.type === "mention") push(`@[${node.mention.name}](${node.mention.kind}:${node.mention.id})`, format);
      else if (node.type === "link") walk(node.children, [...format, `link:${node.href}`]);
      else walk(node.children, [...format, node.type]);
    }
  };
  for (const block of parseMarkdown(markdown)) if (block.type === "paragraph") walk(block.children, []);
  return out;
}

function intendedLook(text: string, spans: InlineSpan[]): Look {
  return {
    text,
    formats: [...text].map((char, index) =>
      /\s/.test(char)
        ? ""
        : spans
            .filter((span) => span.from <= index && index < span.to)
            .map((span) => (span.kind === "link" ? `link:${span.href}` : span.kind))
            .sort()
            .join(","),
    ),
  };
}

function sends(text: string, spans: InlineSpan[]) {
  const markdown = toMarkdown({ text, lines: [{ kind: "text" }], spans });
  assert.deepEqual(parsedLook(markdown), intendedLook(text, spans), `${JSON.stringify(text)} ${JSON.stringify(spans)} wrote ${JSON.stringify(markdown)}`);
  return markdown;
}

const SAM = "@[Sam Smith](member:123e4567-e89b-12d3-a456-426614174000)";
const FORMATS: { kind: InlineKind; href?: string }[] = [{ kind: "bold" }, { kind: "italic" }, { kind: "strike" }, { kind: "code" }, { kind: "link", href: "https://acme.test/a_(b)" }];

describe("chat rich composer: Markdown it sends", () => {
  it("nests every pair of formats either way round, and writes overlaps", () => {
    const text = "see the plan here";
    for (const outer of FORMATS) {
      for (const inner of FORMATS) {
        if (outer.kind === inner.kind || outer.kind === "code") continue;
        sends(text, [
          { from: 0, to: text.length, ...outer },
          { from: 8, to: 12, ...inner },
        ]);
        sends(text, [
          { from: 4, to: 12, ...outer },
          { from: 4, to: 7, ...inner },
        ]);
        if (inner.kind !== "code") {
          sends(text, [
            { from: 0, to: 12, ...outer },
            { from: 8, to: 17, ...inner },
          ]);
        }
      }
    }
  });

  it("keeps a bold sentence with a link in it, and the cases the review found", () => {
    for (const markdown of ["**please read [the docs](https://x.test) today**", "_a **b** c_", "~~a **b** c~~", "**a**_b_", "**a _b_ c**"]) assert.equal(toMarkdown(fromMarkdown(markdown)), markdown);
    let state = editor("see the docs here");
    state = select(state, 0, 17);
    state = apply(state, inlineToggle(state, "italic"));
    state = select(state, 8, 12);
    state = apply(state, inlineToggle(state, "bold"));
    assert.equal(stateMarkdown(state), "_see the **docs** here_");
    state = editor("**please read [the docs](https://x.test) today**");
    state = select(state, 26);
    state = type(state, " now");
    assert.equal(stateMarkdown(state), "**please read [the docs](https://x.test) today now**");
  });

  it("keeps real mentions inside and around formatting", () => {
    for (const markdown of [`**hi ${SAM} there**`, `_${SAM}_ and ~~${SAM}~~`, `[see ${SAM}](https://x.test) ${SAM}`, `**a _${SAM} b_ c**`]) {
      const doc = fromMarkdown(markdown);
      assert.equal(sends(doc.text, doc.spans), markdown);
    }
  });

  it("writes random nesting and overlaps as Markdown that reads back the same", () => {
    let seed = 3;
    const random = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    const words = ["hello", "the", "plan", "Q3", "it's", "ok?", "a,", "50%", "(note)", "😀", SAM, "x.", "don't", "C:\\dir"];
    for (let round = 0; round < 1500; round += 1) {
      const parts = Array.from({ length: 2 + random(6) }, () => words[random(words.length)]);
      const text = parts.join(" ");
      const edges = [0];
      for (const part of parts) edges.push(edges[edges.length - 1] + part.length + 1);
      const spans: InlineSpan[] = [];
      for (let count = random(4); count > 0; count -= 1) {
        const first = random(parts.length);
        const last = first + random(parts.length - first);
        const format = FORMATS[random(FORMATS.length)];
        if (format.kind === "code" && spans.some((span) => span.from < edges[last + 1] - 1 && edges[first] < span.to)) continue;
        if (spans.some((span) => span.kind === "code" && span.from < edges[last + 1] - 1 && edges[first] < span.to)) continue;
        spans.push({ from: edges[first], to: edges[last + 1] - 1, ...format });
      }
      const wanted = normalSpans(text, [{ kind: "text" }], spans);
      sends(text, wanted);
    }
  });

  it("keeps two code blocks apart, each with its language", () => {
    assert.equal(toMarkdown(fromMarkdown("```js\na\n```\n```py\nb\n```")), "```js\na\n```\n```py\nb\n```");
    let state = editor("```js\na\n```\n```py\nb\n```");
    state = select(state, 1);
    state = type(state, "x");
    assert.equal(stateMarkdown(state), "```js\nax\n```\n```py\nb\n```");
  });

  it("copies the selected part as Markdown", () => {
    const doc = fromMarkdown("say **hello there** now\n- one\n- **two**");
    assert.equal(sliceMarkdown(doc, 4, 9), "**hello**");
    assert.equal(sliceMarkdown(doc, 0, doc.text.length), "say **hello there** now\n- one\n- **two**");
    assert.equal(sliceMarkdown(doc, 20, doc.text.length), "- one\n- **two**");
    assert.equal(sliceMarkdown(doc, 21, 23), "ne");
  });
});

describe("chat rich composer: undo keeps formatting", () => {
  function run(state: EditorState, command: typeof undo) {
    let next = state;
    command({ state, dispatch: (tr: Transaction) => (next = tr.state) });
    return next;
  }

  it("brings formatting back with deleted, cut and converted text, and redoes it", () => {
    let state = editor("hello **world** there");
    state = select(state, 6, 11);
    state = backspace(state);
    assert.equal(stateMarkdown(state), "hello  there");
    state = run(state, undo);
    assert.equal(stateMarkdown(state), "hello **world** there");
    state = run(state, redo);
    assert.equal(stateMarkdown(state), "hello  there");

    state = editor("- one\n- **two**\n\n> quote");
    state = select(state, 0, state.doc.length);
    state = apply(state, { ...state.replaceSelection(""), userEvent: "delete.cut" });
    assert.equal(stateMarkdown(state), "");
    state = run(state, undo);
    assert.equal(stateMarkdown(state), "- one\n- **two**\n\n> quote");

    state = editor("");
    state = type(state, "**x** ");
    assert.equal(stateMarkdown(state), "**x** ");
    state = run(state, undo);
    assert.equal(stateMarkdown(state), "");
    state = run(state, redo);
    assert.equal(stateMarkdown(state), "**x** ");

    state = editor("say ");
    state = apply(state, inlineToggle(state, "bold"));
    state = type(state, "loud");
    assert.equal(stateMarkdown(state), "say **loud**");
    state = run(state, undo);
    assert.equal(stateMarkdown(state), "say ");
    state = run(state, redo);
    assert.equal(stateMarkdown(state), "say **loud**");
  });

  it("forgets earlier messages once the box is loaded again, as after sending", () => {
    let state = editor("");
    state = type(state, "call him an idiot");
    state = select(state, 0, state.doc.length);
    state = backspace(state);
    state = type(state, "sounds good");
    for (const spec of reloadMarkdown(state, "")) state = apply(state, spec);
    assert.equal(shown(state), "");
    assert.equal(run(state, undo), state);
    state = type(state, "next");
    state = run(state, undo);
    assert.equal(shown(state), "");
  });

  it("forgets the last conversation's edits when the box moves to another with the same text", () => {
    let state = editor("");
    state = type(state, "private note");
    state = backspace(state);
    for (const spec of reloadMarkdown(state, "")) state = apply(state, spec);
    for (const spec of resetHistory()) state = apply(state, spec);
    assert.equal(run(state, undo), state);
    state = type(state, "hi");
    state = run(state, undo);
    assert.equal(shown(state), "");
    state = run(state, redo);
    assert.equal(shown(state), "hi");
  });
});

describe("chat rich composer: links after the text changes", () => {
  it("clamps a link to the text that is there", () => {
    let state = editor("short");
    state = apply(state, linkEdit(state, { from: 0, to: 40, href: "https://acme.test" }));
    assert.equal(stateMarkdown(state), "[short](https://acme.test)");
  });
});

describe("chat rich composer: list numbers", () => {
  it("gives every item in a list room for its widest number", () => {
    const markdown = Array.from({ length: 10 }, (_, index) => `${index + 1}. item`).join("\n");
    const state = editor(`${markdown}\n\n- dot`);
    const classes: string[] = [];
    const cursor = richDecorations(state).iter();
    for (; cursor.value; cursor.next()) if (String(cursor.value.spec.class).includes("chat-li-number")) classes.push(`${cursor.value.spec.attributes["data-n"]} ${cursor.value.spec.class}`);
    assert.equal(classes.length, 10);
    assert.ok(classes.every((item) => item.endsWith("chat-li-w2")));
    assert.equal(classes[9], "10. chat-li chat-li-number chat-li-w2");
  });
});
