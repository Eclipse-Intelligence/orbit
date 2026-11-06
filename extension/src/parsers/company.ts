import type { PageCompany } from "../../../lib/extension/protocol";
import { domainFrom, targetFromUrl } from "../urls";
import { after, clean, firstElement, firstText, headings, pageTitle, realValue, safeAll, sameText, textLines, textOf } from "./text";

const OLD_TOP_CARD = [".org-top-card", "[data-test-id='org-top-card']"];

const OLD_NAME = ["h1.org-top-card-summary__title", ".org-top-card h1", "[data-test-id='org-name']"];

const OLD_TAGLINE = [".org-top-card-summary__tagline", ".org-top-card p.t-16", "[data-test-id='org-tagline']", ".org-top-card p"];

const OLD_INFO = ".org-top-card-summary-info-list__info-item, .org-top-card-summary-info-list > *, [data-test-id='org-info'] li";

const PAGE_TAB = /\s*:\s*(?:about|overview|home|posts|jobs|people|life|insights|videos|events|products)$/i;

const NOT_INFO =
  /^(?:follow|following|message|more|visit website|contact us|home|about|posts|jobs|people|life|insights|videos|events|products|view all .*|see all .*|show all .*)$|^\d[\d,.]*\s*(?:connections?|mutual)|\bwork here\b/i;

function companyHeading(root: ParentNode, wanted: string | null): Element | null {
  const all = headings(root);
  if (wanted) {
    const exact = all.find((heading) => sameText(textOf(heading), wanted));
    if (exact) return exact;
  }
  return firstElement(root, OLD_NAME) ?? safeAll(safeAll(root, "main")[0] ?? root, "h1").find((heading) => realValue(textOf(heading))) ?? null;
}

function aboutPairs(root: ParentNode) {
  const pairs = new Map<string, { text: string | null; href: string | null }>();
  for (const term of safeAll(root, "dt")) {
    const label = clean(term.textContent)?.toLowerCase();
    if (!label || pairs.has(label)) continue;
    let next = term.nextElementSibling;
    while (next && next.tagName.toLowerCase() !== "dd" && next.tagName.toLowerCase() !== "dt") next = next.nextElementSibling;
    if (!next || next.tagName.toLowerCase() !== "dd") continue;
    const link = next.querySelector("a[href]");
    pairs.set(label, { text: textOf(next), href: link?.getAttribute("href") ?? null });
  }
  return pairs;
}

function pick(pairs: Map<string, { text: string | null; href: string | null }>, names: RegExp) {
  for (const [label, value] of pairs) if (names.test(label)) return value;
  return null;
}

function sizeOf(value: string | null) {
  if (!value) return null;
  const match = /(\d[\d,.]*\s*(?:-|to)\s*\d[\d,.]*|\d[\d,.]*\+)/.exec(value);
  if (match) return clean(match[1].replace(/\s*to\s*/, "-").replace(/\s*-\s*/, "-"));
  return clean(value.replace(/employees?/i, ""));
}

function infoItems(top: ParentNode, lines: string[]) {
  const old = safeAll(top, OLD_INFO)
    .map((element) => textOf(element))
    .filter((text): text is string => Boolean(text));
  if (old.length > 0) return old;
  return lines.filter((text) => text.length <= 80 && !NOT_INFO.test(text)).flatMap((text) => text.split(/\s+[·•]\s+/));
}

function websiteLink(root: ParentNode) {
  for (const anchor of safeAll(root, "a[href]")) {
    const text = clean(anchor.textContent)?.toLowerCase() ?? "";
    const label = clean(anchor.getAttribute("aria-label"))?.toLowerCase() ?? "";
    if (!/visit website|website/.test(`${text} ${label}`)) continue;
    const href = anchor.getAttribute("href");
    if (domainFrom(href)) return href;
  }
  return null;
}

export function readCompany(root: ParentNode, url: string): PageCompany {
  const titleName = realValue(pageTitle(root)?.replace(PAGE_TAB, ""));
  const heading = companyHeading(root, titleName);
  const top = heading?.closest("section") ?? firstElement(root, OLD_TOP_CARD) ?? safeAll(root, "main")[0] ?? root;
  const name = realValue(textOf(heading)) ?? titleName;
  const lines = heading ? textLines(top).filter((line) => after(heading, line.element)) : [];
  const taglineLine = lines.find(({ text }) => text.length <= 300 && !sameText(text, name) && !NOT_INFO.test(text) && !/followers|employees/i.test(text) && realValue(text));
  const tagline = taglineLine?.text ?? realValue(firstText(top, OLD_TAGLINE));
  const rest = taglineLine ? lines.filter((line) => after(taglineLine.element, line.element)) : lines;
  const pairs = aboutPairs(root);
  const items = infoItems(top, rest.map((line) => line.text));
  const website = pick(pairs, /^website/);
  const industry = pick(pairs, /^industr/)?.text ?? items.find((item) => !/followers|employees|,/i.test(item)) ?? null;
  const size = pick(pairs, /company size|^size/)?.text ?? items.find((item) => /employees/i.test(item)) ?? null;
  const location = pick(pairs, /headquarters|location/)?.text ?? items.find((item) => /,/.test(item) && !/followers|employees/i.test(item)) ?? null;
  const websiteValue = website?.href && domainFrom(website.href) ? website.href : (website?.text ?? websiteLink(root));
  const target = targetFromUrl(url);
  return {
    name,
    tagline,
    website: clean(websiteValue),
    industry: realValue(industry),
    sizeCategory: sizeOf(size),
    location: clean(location),
    linkedinUrl: target.kind === "company" ? target.canonical : null,
  };
}
