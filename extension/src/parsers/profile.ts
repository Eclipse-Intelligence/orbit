import type { PagePerson } from "../../../lib/extension/protocol";
import { canonicalCompany, targetFromUrl } from "../urls";
import { attr, clean, firstElement, firstText, headlineParts, safeAll, sectionTitled, splitName, textOf } from "./text";

const TOP_CARD = [".pv-top-card", "section.artdeco-card.pv-top-card", "main section:first-of-type", "main", "body"];

const NAME = ["h1.text-heading-xlarge", ".pv-top-card h1", ".ph5 h1", "main section h1", "h1"];

const HEADLINE = [
  ".pv-text-details__left-panel .text-body-medium",
  ".pv-top-card .text-body-medium",
  "[data-generated-suggestion-target]",
  ".text-body-medium.break-words",
  "[data-field='headline']",
];

const LOCATION = [
  ".pv-text-details__left-panel .text-body-small.inline.t-black--light",
  ".pv-top-card .text-body-small.inline.t-black--light",
  ".pv-top-card--list-bullet .text-body-small",
  "[data-field='location']",
  ".text-body-small.inline.t-black--light.break-words",
];

function leafTexts(root: Element): string[] {
  const out: string[] = [];
  for (const element of safeAll(root, "span, p, div, a, h3, strong")) {
    if (element.children.length > 0) continue;
    if (element.closest(".visually-hidden, .sr-only")) continue;
    const text = clean(element.textContent);
    if (text && out[out.length - 1] !== text) out.push(text);
  }
  return out;
}

function boldTexts(scope: Element, owner: Element) {
  const found = safeAll(scope, ".t-bold, .mr1.t-bold, [data-field='title'], h3")
    .filter((element) => element.closest("li") === owner)
    .map((element) => textOf(element))
    .filter((text): text is string => Boolean(text));
  return [...new Set(found)];
}

function companyFromLine(line: string | null) {
  return clean(line?.split(/\s+·\s+|\s+•\s+/)[0] ?? null);
}

export type ExperienceRole = { jobTitle: string | null; companyName: string | null; companyLinkedinUrl: string | null };

export function readExperience(root: ParentNode, base: string): ExperienceRole {
  const empty = { jobTitle: null, companyName: null, companyLinkedinUrl: null };
  const section = sectionTitled(root, "experience", /^experience$/i);
  if (!section) return empty;
  const top = safeAll(section, "li").find((item) => !item.parentElement?.closest("li") && textOf(item));
  if (!top) return empty;
  const link = safeAll(top, "a[href*='/company/']").map((anchor) => anchor.getAttribute("href")).find(Boolean) ?? null;
  const companyLinkedinUrl = canonicalCompany(link, base);
  const nested = safeAll(top, "li").filter((item) => item !== top && textOf(item));
  const ownBold = boldTexts(top, top);
  if (nested.length > 0) {
    const roleBold = boldTexts(nested[0], nested[0]);
    const jobTitle = roleBold[0] ?? leafTexts(nested[0])[0] ?? null;
    if (ownBold[0] && jobTitle) return { jobTitle, companyName: ownBold[0], companyLinkedinUrl };
  }
  const companyLine =
    firstText(top, [".t-14.t-normal:not(.t-black--light)", "[data-field='company']", ".pv-entity__secondary-title"]) ?? null;
  if (ownBold[0]) return { jobTitle: ownBold[0], companyName: companyFromLine(companyLine), companyLinkedinUrl };
  const lines = leafTexts(top);
  return { jobTitle: lines[0] ?? null, companyName: companyFromLine(lines[1] ?? null), companyLinkedinUrl };
}

function topCardCompany(top: ParentNode) {
  for (const button of safeAll(top, "button[aria-label], a[aria-label]")) {
    const label = attr(button, "aria-label");
    const match = label ? /current company:\s*(.+?)(?:\.\s|\.$|$)/i.exec(label) : null;
    if (match) return clean(match[1]);
  }
  return firstText(top, [
    ".pv-text-details__right-panel-item-text",
    "[data-field='experience_company_logo'] span",
    ".pv-top-card--experience-list-item",
  ]);
}

function textAfterName(top: ParentNode) {
  const heading = firstElement(top, NAME);
  let next = heading?.nextElementSibling ?? null;
  while (next) {
    const text = textOf(next);
    if (text && text.length <= 220) return text;
    next = next.nextElementSibling;
  }
  return null;
}

export function readProfile(root: ParentNode, url: string): PagePerson {
  const base = url;
  const top = firstElement(root, TOP_CARD) ?? root;
  const fullName = firstText(top, NAME) ?? firstText(root, NAME);
  const names = splitName(fullName);
  const headline = firstText(top, HEADLINE) ?? textAfterName(top);
  const location = firstText(top, LOCATION);
  const experience = readExperience(root, base);
  const fromHeadline = headlineParts(headline);
  const target = targetFromUrl(url);
  const linkedinUrl = target.kind === "person" ? target.canonical : null;
  return {
    name: names.name,
    firstName: names.firstName,
    lastName: names.lastName,
    headline,
    jobTitle: experience.jobTitle ?? fromHeadline.jobTitle,
    location,
    linkedinUrl,
    salesNavigatorUrl: null,
    companyName: experience.companyName ?? topCardCompany(top) ?? fromHeadline.companyName,
    companyLinkedinUrl: experience.companyLinkedinUrl,
  };
}
