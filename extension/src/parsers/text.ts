import { dateRangeIn, looksLikeDateOrDuration, looksLikeEmploymentType } from "../../../lib/extension/protocol";

export { dateRangeIn, looksLikeDateOrDuration };

export function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text : null;
}

const HIDDEN = ".visually-hidden, .sr-only, .a11y-text, script, style, template, noscript";

export function textOf(element: Element | null | undefined): string | null {
  if (!element) return null;
  try {
    const visible = element.querySelector(':scope > span[aria-hidden="true"]');
    if (visible) {
      const text = clean(visible.textContent);
      if (text) return text;
    }
    const clone = element.cloneNode(true) as Element;
    clone.querySelectorAll(HIDDEN).forEach((node) => node.remove());
    return clean(clone.textContent);
  } catch {
    return null;
  }
}

export function safeAll(root: ParentNode | null | undefined, selector: string): Element[] {
  if (!root) return [];
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

export function firstElement(root: ParentNode | null | undefined, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const found = safeAll(root, selector).find((element) => textOf(element));
    if (found) return found;
  }
  return null;
}

export function firstText(root: ParentNode | null | undefined, selectors: string[]): string | null {
  return textOf(firstElement(root, selectors));
}

export function fold(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function sameText(left: string | null | undefined, right: string | null | undefined) {
  const a = fold(left);
  return Boolean(a) && a === fold(right);
}

const GENERIC_TITLE = /^(?:linkedin|sales navigator|feed|messaging|notifications|my network|jobs|search|home|log in|sign in|sign up)$/i;

export function pageTitle(root: ParentNode): string | null {
  try {
    const node = root as Node;
    const doc = node.nodeType === 9 ? (node as Document) : node.ownerDocument;
    const title = clean(doc?.title);
    if (!title) return null;
    const name = clean(title.replace(/^\(\d+\+?\)\s*/, "").replace(/\s*\|\s*(?:LinkedIn|Sales Navigator)\b.*$/i, ""));
    return name && !GENERIC_TITLE.test(name) ? name : null;
  } catch {
    return null;
  }
}

export function headings(root: ParentNode | null | undefined) {
  return safeAll(root, "h1, h2, h3, [role='heading']");
}

export function headingTitled(root: ParentNode, title: RegExp): Element | null {
  return headings(root).find((heading) => title.test(textOf(heading) ?? "")) ?? null;
}

export function sectionTitled(root: ParentNode, anchorId: string, title: RegExp): Element | null {
  const anchor = safeAll(root, `#${anchorId}, [componentkey$='_${anchorId}' i]`)[0];
  const byAnchor = anchor?.closest("section");
  if (byAnchor) return byAnchor;
  const heading = headingTitled(root, title);
  const byHeading = heading?.closest("section") ?? heading?.parentElement?.parentElement ?? null;
  if (byHeading) return byHeading;
  for (const section of safeAll(root, "section")) {
    const first = firstText(section, ["h2", "h3", "[role=heading]"]);
    if (first && title.test(first)) return section;
  }
  return null;
}

export type Line = { element: Element; text: string };

function ownText(element: Element) {
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3 && node.textContent && node.textContent.trim()) return true;
  }
  return false;
}

export function textLines(scope: ParentNode | null | undefined, skip?: (element: Element) => boolean): Line[] {
  const lines: Line[] = [];
  let taken: Element | null = null;
  for (const element of safeAll(scope, "*")) {
    if (taken && taken.contains(element)) continue;
    if (!ownText(element)) continue;
    if (element.closest(`${HIDDEN}, svg, button, [data-testid*='expandable-text']`)) continue;
    if (skip?.(element)) continue;
    taken = element;
    const text = textOf(element);
    if (text && lines[lines.length - 1]?.text !== text) lines.push({ element, text });
  }
  return lines;
}

export function after(anchor: Element | null, element: Element) {
  if (!anchor) return true;
  if (anchor === element || anchor.contains(element)) return false;
  return Boolean(anchor.compareDocumentPosition(element) & 4);
}

const WORKPLACE = /^(?:hybrid|h[ií]brido|ibrido|hybride|remote|remoto|t[eé]l[eé]travail|on[- ]site|vor ort|presencial|sur site|in sede|op locatie)$/iu;
const DEGREE = /^(?:1st|2nd|3rd\+?)(?:\s+degree(?:\s+connection)?)?$/i;
const LOCATION = /(?:^greater\s[^,]+,|\sarea(?:,|$)|\smetropolitan area\b)/i;
const SEPARATOR = /^[\s·•|,.:;+\-]*$/;

export function isPageMeta(value: string | null | undefined): boolean {
  const text = clean(value);
  if (!text) return true;
  if (SEPARATOR.test(text) || /^[·•,]/.test(text)) return true;
  if (looksLikeDateOrDuration(text) || looksLikeEmploymentType(text)) return true;
  const parts = text.split(/\s*[·•]\s*/).filter(Boolean);
  return parts.some((part) => WORKPLACE.test(part) || DEGREE.test(part));
}

export function looksLikeLocation(value: string | null | undefined) {
  const text = clean(value);
  return Boolean(text && LOCATION.test(text.split(/\s+[·•]\s+/)[0]));
}

export function realValue(value: string | null | undefined): string | null {
  const text = clean(value);
  return text && !isPageMeta(text) ? text : null;
}

export function splitName(name: string | null): { firstName: string | null; lastName: string | null; name: string | null } {
  const tidy = realValue(name?.replace(/\([^)]*\)/g, " ").split(/,\s/)[0]);
  if (!tidy) return { firstName: null, lastName: null, name: null };
  const parts = tidy.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: null, name: tidy };
  return { firstName: parts[0], lastName: parts.slice(1).join(" "), name: tidy };
}

export function attr(element: Element | null | undefined, name: string): string | null {
  try {
    return clean(element?.getAttribute(name) ?? null);
  } catch {
    return null;
  }
}

export function headlineParts(headline: string | null): { jobTitle: string | null; companyName: string | null } {
  const empty = { jobTitle: null, companyName: null };
  if (!headline) return empty;
  const segments = headline
    .split(/\s*[|•·]\s*/)
    .map((segment) => clean(segment))
    .filter((segment): segment is string => Boolean(segment) && segment!.length <= 120);
  for (const segment of segments) {
    const at = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(segment);
    const jobTitle = realValue(at?.[1]);
    const companyName = realValue(at?.[2]);
    if (jobTitle && companyName && jobTitle.split(" ").length <= 8) return { jobTitle, companyName };
  }
  const first = segments[0];
  if (!first) return empty;
  const comma = /^(.+?),\s+(.+)$/.exec(first);
  if (comma && realValue(comma[1]) && realValue(comma[2])) return { jobTitle: realValue(comma[1]), companyName: realValue(comma[2]) };
  return { jobTitle: realValue(first), companyName: null };
}
