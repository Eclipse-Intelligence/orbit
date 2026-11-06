import type { PagePerson } from "../../../lib/extension/protocol";
import { canonicalCompany, targetFromUrl } from "../urls";
import {
  after,
  attr,
  clean,
  dateRangeIn,
  firstElement,
  firstText,
  headings,
  headlineParts,
  isPageMeta,
  looksLikeDateOrDuration,
  looksLikeLocation,
  pageTitle,
  realValue,
  safeAll,
  sameText,
  sectionTitled,
  splitName,
  textLines,
  textOf,
  type Line,
} from "./text";

const OLD_TOP_CARD = [".pv-top-card", "section.artdeco-card.pv-top-card"];

const OLD_NAME = ["h1.text-heading-xlarge", ".pv-top-card h1", ".ph5 h1"];

const OLD_HEADLINE = [
  ".pv-text-details__left-panel .text-body-medium",
  ".pv-top-card .text-body-medium",
  "[data-generated-suggestion-target]",
  ".text-body-medium.break-words",
  "[data-field='headline']",
];

const OLD_LOCATION = [
  ".pv-text-details__left-panel .text-body-small.inline.t-black--light",
  ".pv-top-card .text-body-small.inline.t-black--light",
  ".pv-top-card--list-bullet .text-body-small",
  "[data-field='location']",
  ".text-body-small.inline.t-black--light.break-words",
];

const OLD_COMPANY = [".pv-text-details__right-panel-item-text", "[data-field='experience_company_logo'] span", ".pv-top-card--experience-list-item"];

const SECTION_HEADING =
  /^(?:about|activity|experience|education|skills|featured|services|interests|languages|recommendations|projects|volunteering|licenses|courses|honors|publications|people you may know|people also viewed|you might like|explore premium profiles|ad options|.*notifications?)$/i;

const NOT_HEADLINE = /^(?:contact info|message|connect|follow|following|more|save|pending|view my services|open to)$|\bconnections?$|\bfollowers?$|mutual connections?|^\(?(?:he|she|they)\/\w+\)?$/i;

const MORE_COMPANIES = /\+\s*\d+\s+more\b/i;

function moreCompaniesLead(text: string) {
  const first = text.split(/\s+[·•]\s+/)[0];
  return /^(.+?)\s*\+\s*\d+\s+more$/i.exec(first)?.[1] ?? null;
}

function nameHeading(root: ParentNode, wanted: string | null): Element | null {
  const all = headings(root);
  if (wanted) {
    const exact = all.find((heading) => sameText(textOf(heading), wanted));
    if (exact) return exact;
  }
  const old = firstElement(root, OLD_NAME);
  if (old) return old;
  const main = safeAll(root, "main")[0] ?? root;
  const h1 = safeAll(main, "h1").find((heading) => realValue(textOf(heading)));
  if (h1) return h1;
  return (
    safeAll(main, "h2").find((heading) => {
      const text = textOf(heading);
      return Boolean(realValue(text)) && !SECTION_HEADING.test(text ?? "") && (text ?? "").split(" ").length <= 6;
    }) ?? null
  );
}

function topCardOf(root: ParentNode, heading: Element | null): ParentNode {
  return heading?.closest("section") ?? firstElement(root, OLD_TOP_CARD) ?? safeAll(root, "main")[0] ?? root;
}

function headlineFrom(lines: Line[], name: string | null) {
  const line = lines.find(({ text }) => text.length <= 300 && !sameText(text, name) && !NOT_HEADLINE.test(text) && !isPageMeta(text) && !looksLikeLocation(text) && !MORE_COMPANIES.test(text));
  return line ?? null;
}

function locationCandidate(text: string, headline: string | null) {
  if (text.length > 120 || sameText(text, headline)) return false;
  if (/^[\s·•,]*$/.test(text) || /^[·•,]/.test(text) || /[|@]/.test(text)) return false;
  if (looksLikeDateOrDuration(text) || NOT_HEADLINE.test(text) || MORE_COMPANIES.test(text)) return false;
  return true;
}

function locationFrom(top: ParentNode, lines: Line[], headline: string | null) {
  const contact = safeAll(top, "a[href*='contact-info']")[0];
  if (contact) {
    const before = lines.filter((line) => !line.element.contains(contact) && Boolean(contact.compareDocumentPosition(line.element) & 2)).reverse();
    for (const { text } of before) {
      if (/^[\s·•,]*$/.test(text)) continue;
      if (locationCandidate(text, headline) && !/^[·•]/.test(text)) return text;
      break;
    }
  }
  const pattern = lines.find(({ text }) => locationCandidate(text, headline) && /,|\sarea$/i.test(text) && !/\d/.test(text) && text.split(" ").length <= 10);
  return pattern?.text ?? null;
}

function topCardCompany(top: ParentNode, lines: Line[]) {
  for (const element of safeAll(top, "button[aria-label], a[aria-label]")) {
    const label = attr(element, "aria-label");
    const match = label ? /current company:\s*(.+?)(?:\.\s|\.$|$)/i.exec(label) : null;
    if (match && realValue(match[1])) return clean(match[1]);
  }
  for (const { text } of lines) {
    const lead = moreCompaniesLead(text);
    if (lead && realValue(lead)) return clean(lead);
  }
  return realValue(firstText(top, OLD_COMPANY));
}

type ExperienceRole = { jobTitle: string | null; companyName: string | null; companyLinkedinUrl: string | null };

function companyFromLine(line: string | null | undefined) {
  return realValue(line?.split(/\s+[·•]\s+/)[0]);
}

function entryLine(element: Element) {
  if (element.closest("a[href*='skill']")) return true;
  const text = clean(element.textContent) ?? "";
  return text.length > 200 || /\band \+\d+ skills?$/i.test(text);
}

function linesIn(scope: Element, exclude: Element[] = []) {
  return textLines(scope, (element) => entryLine(element) || exclude.some((item) => item.contains(element))).map((line) => line.text);
}

function roleFrom(lines: string[]) {
  const end = lines.findIndex((line) => dateRangeIn(line));
  const head = end >= 0 ? lines.slice(0, end) : lines;
  const index = head.findIndex((line) => !isPageMeta(line));
  if (index < 0) return { jobTitle: null, companyName: null };
  const companyName = head.slice(index + 1).map(companyFromLine).find(Boolean) ?? null;
  return { jobTitle: realValue(head[index]), companyName };
}

function outermost(elements: Element[]) {
  return elements.filter((element) => !elements.some((other) => other !== element && other.contains(element)));
}

function isCurrent(lines: string[]) {
  return lines.some((line) => dateRangeIn(line) === "current");
}

type Entry = { element: Element; roles: Element[]; lines: string[] };

function entriesIn(section: Element): Entry[] {
  const candidates = safeAll(section, "[componentkey^='entity-collection-item'], li").filter((element) => linesIn(element).length > 0);
  const tops = outermost(candidates);
  return (tops.length > 0 ? tops : [section]).map((element) => {
    const roles = outermost(safeAll(element, "li").filter((item) => item !== element && linesIn(item).some((line) => dateRangeIn(line))));
    return { element, roles, lines: linesIn(element, roles) };
  });
}

function readExperience(root: ParentNode, base: string): ExperienceRole {
  const empty = { jobTitle: null, companyName: null, companyLinkedinUrl: null };
  const section = sectionTitled(root, "experience", /^experience$/i);
  if (!section) return empty;
  const entries = entriesIn(section);
  const current =
    entries.find((entry) => (entry.roles.length > 0 ? entry.roles.some((role) => isCurrent(linesIn(role))) : isCurrent(entry.lines))) ?? entries[0];
  if (!current) return empty;
  const link = safeAll(current.element, "a[href*='/company/']").map((anchor) => anchor.getAttribute("href")).find(Boolean) ?? null;
  const companyLinkedinUrl = canonicalCompany(link, base);
  if (current.roles.length > 0) {
    const role = current.roles.find((item) => isCurrent(linesIn(item))) ?? current.roles[0];
    const companyName = current.lines.filter((line) => !looksLikeLocation(line)).map(companyFromLine).find(Boolean) ?? null;
    return { jobTitle: roleFrom(linesIn(role)).jobTitle, companyName, companyLinkedinUrl };
  }
  return { ...roleFrom(current.lines), companyLinkedinUrl };
}

export function readProfile(root: ParentNode, url: string): PagePerson {
  const titleName = realValue(pageTitle(root));
  const heading = nameHeading(root, titleName);
  const fullName = realValue(textOf(heading)) ?? titleName;
  const names = splitName(fullName);
  const top = topCardOf(root, heading);
  const lines = heading ? textLines(top).filter((line) => after(heading, line.element)) : [];
  const headlineLine = headlineFrom(lines, names.name);
  const headline = headlineLine?.text ?? realValue(firstText(top, OLD_HEADLINE));
  const rest = headlineLine ? lines.filter((line) => after(headlineLine.element, line.element)) : lines;
  const location = locationFrom(top, rest, headline) ?? clean(firstText(top, OLD_LOCATION));
  const experience = readExperience(root, url);
  const fromHeadline = headlineParts(headline);
  const target = targetFromUrl(url);
  return {
    name: names.name,
    firstName: names.firstName,
    lastName: names.lastName,
    headline,
    jobTitle: experience.jobTitle ?? fromHeadline.jobTitle,
    location,
    linkedinUrl: target.kind === "person" ? target.canonical : null,
    salesNavigatorUrl: null,
    companyName: experience.companyName ?? topCardCompany(top, rest) ?? fromHeadline.companyName,
    companyLinkedinUrl: experience.companyLinkedinUrl,
  };
}
