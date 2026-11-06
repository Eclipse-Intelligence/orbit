import type { PageCompany } from "../../../lib/extension/protocol";
import { domainFrom, targetFromUrl } from "../urls";
import { clean, firstElement, firstText, safeAll, textOf } from "./text";

const TOP_CARD = [".org-top-card", "[data-test-id='org-top-card']", "main section:first-of-type", "main", "body"];

const NAME = ["h1.org-top-card-summary__title", ".org-top-card h1", "[data-test-id='org-name']", "main h1", "h1"];

const TAGLINE = [".org-top-card-summary__tagline", ".org-top-card p.t-16", "[data-test-id='org-tagline']", ".org-top-card p"];

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

function infoItems(top: ParentNode) {
  return safeAll(top, ".org-top-card-summary-info-list__info-item, .org-top-card-summary-info-list > *, [data-test-id='org-info'] li")
    .map((element) => textOf(element))
    .filter((text): text is string => Boolean(text));
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
  const top = firstElement(root, TOP_CARD) ?? root;
  const pairs = aboutPairs(root);
  const items = infoItems(top);
  const website = pick(pairs, /^website/);
  const industry = pick(pairs, /^industr/)?.text ?? items.find((item) => !/followers|employees|,/i.test(item)) ?? null;
  const size = pick(pairs, /company size|^size/)?.text ?? items.find((item) => /employees/i.test(item)) ?? null;
  const location = pick(pairs, /headquarters|location/)?.text ?? items.find((item) => /,/.test(item) && !/followers|employees/i.test(item)) ?? null;
  const websiteValue = website?.href && domainFrom(website.href) ? website.href : (website?.text ?? websiteLink(root));
  const target = targetFromUrl(url);
  return {
    name: firstText(top, NAME) ?? firstText(root, NAME),
    tagline: firstText(top, TAGLINE),
    website: clean(websiteValue),
    industry: clean(industry),
    sizeCategory: sizeOf(size),
    location: clean(location),
    linkedinUrl: target.kind === "company" ? target.canonical : null,
  };
}
