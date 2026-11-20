import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from "@codemirror/state";
import { formatsAt, markdownMarks, parseMarkdown } from "@/lib/chat/markdown";
import { activeFormats, chatEditorExtensions, inlineToggle, lineStartBackspace, lineToggle, linkEdit, loadMarkdown, newline, richDecorations, richDoc, stateMarkdown } from "@/lib/chat/rich-editor";
import { cleanHref, fromMarkdown, sameLook, tightenAt, toMarkdown } from "@/lib/chat/rich-text";

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
