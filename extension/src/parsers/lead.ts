import type { PagePerson } from "../../../lib/extension/protocol";
import { canonicalCompany, canonicalProfile, targetFromUrl } from "../urls";
import { after, firstText, headings, headlineParts, isPageMeta, pageTitle, realValue, safeAll, sameText, splitName, textLines, textOf } from "./text";

const NAME = ["[data-anonymize='person-name']", "[data-x--lead--name]", ".profile-topcard-person-entity__name"];
const TITLE = ["[data-anonymize='job-title']", "[data-x--lead--title]", ".profile-topcard__current-positions [data-anonymize='title']"];
const HEADLINE = ["[data-anonymize='headline']", "[data-x--lead--headline]", ".profile-topcard__summary-position"];
const COMPANY = ["[data-anonymize='company-name']", "a[href*='/sales/company/']", "[data-x--lead--company]"];
const LOCATION = ["[data-anonymize='location']", "[data-x--lead--location]", ".profile-topcard__location-data"];

function nameHeading(root: ParentNode, wanted: string | null): Element | null {
  const all = headings(root);
  if (wanted) {
    const exact = all.find((heading) => sameText(textOf(heading), wanted));
    if (exact) return exact;
  }
  return safeAll(root, "h1").find((heading) => realValue(textOf(heading))) ?? null;
}

export function readLead(root: ParentNode, url: string): PagePerson {
  const titleName = realValue(pageTitle(root));
  const heading = nameHeading(root, titleName);
  const names = splitName(realValue(firstText(root, NAME)) ?? realValue(textOf(heading)) ?? titleName);
  const top = heading?.closest("section") ?? null;
  const lines = top && heading ? textLines(top).filter((line) => after(heading, line.element)) : [];
  const headline =
    realValue(firstText(root, HEADLINE)) ??
    lines.find(({ text }) => text.length <= 300 && !isPageMeta(text) && !sameText(text, names.name) && !/,/.test(text))?.text ??
    null;
  const fromHeadline = headlineParts(headline);
  const profileHref = safeAll(root, "a[href*='/in/']")
    .map((anchor) => anchor.getAttribute("href"))
    .find((href) => canonicalProfile(href, url));
  const companyHref = safeAll(root, "a[href*='/company/']")
    .map((anchor) => anchor.getAttribute("href"))
    .find((href) => canonicalCompany(href, url));
  const target = targetFromUrl(url);
  return {
    name: names.name,
    firstName: names.firstName,
    lastName: names.lastName,
    headline,
    jobTitle: realValue(firstText(root, TITLE)) ?? fromHeadline.jobTitle,
    location: firstText(root, LOCATION),
    linkedinUrl: canonicalProfile(profileHref, url),
    salesNavigatorUrl: target.kind === "lead" ? target.canonical : null,
    companyName: realValue(firstText(root, COMPANY)) ?? fromHeadline.companyName,
    companyLinkedinUrl: canonicalCompany(companyHref, url),
  };
}
