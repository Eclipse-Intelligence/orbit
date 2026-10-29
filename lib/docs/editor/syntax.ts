import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { isTagBoundary, tagAt } from "@/lib/docs/markdown";

const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const HASH = 35;
const AT = 64;
const MENTION = /^@\[([^\]\n]{1,200})\]\((contact|company|task|opportunity|proposal):([0-9a-f-]{36})\)/;

function wikiLink(cx: InlineContext, next: number, pos: number) {
  if (next !== OPEN_BRACKET || cx.char(pos + 1) !== OPEN_BRACKET) return -1;
  for (let at = pos + 2; at < cx.end && at < pos + 205; at += 1) {
    const char = cx.char(at);
    if (char === 10 || char === OPEN_BRACKET) return -1;
    if (char === CLOSE_BRACKET) {
      if (cx.char(at + 1) !== CLOSE_BRACKET || at === pos + 2) return -1;
      return cx.addElement(
        cx.elt("WikiLink", pos, at + 2, [cx.elt("WikiLinkMark", pos, pos + 2), cx.elt("WikiLinkText", pos + 2, at), cx.elt("WikiLinkMark", at, at + 2)]),
      );
    }
  }
  return -1;
}

function hashtag(cx: InlineContext, next: number, pos: number) {
  if (next !== HASH) return -1;
  if (pos > cx.offset && !isTagBoundary(cx.slice(pos - 1, pos))) return -1;
  const found = tagAt(cx.slice(pos, Math.min(cx.end, pos + 120)));
  if (!found) return -1;
  return cx.addElement(cx.elt("Hashtag", pos, pos + found.length, [cx.elt("HashtagMark", pos, pos + 1)]));
}

function mention(cx: InlineContext, next: number, pos: number) {
  if (next !== AT) return -1;
  const match = MENTION.exec(cx.slice(pos, Math.min(cx.end, pos + 260)));
  if (!match) return -1;
  return cx.addElement(cx.elt("Mention", pos, pos + match[0].length));
}

const docsSyntax: MarkdownConfig = {
  defineNodes: ["WikiLink", "WikiLinkMark", "WikiLinkText", "Hashtag", "HashtagMark", "Mention"],
  parseInline: [
    { name: "Mention", parse: mention, before: "Link" },
    { name: "WikiLink", parse: wikiLink, before: "Link" },
    { name: "Hashtag", parse: hashtag, before: "Emphasis" },
  ],
};

const support = markdown({ base: markdownLanguage, extensions: [docsSyntax], addKeymap: false });

export function docsLanguage() {
  return support;
}

export const docsParser = support.language.parser;
