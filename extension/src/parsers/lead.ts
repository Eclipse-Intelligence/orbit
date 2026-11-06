import type { PagePerson } from "../../../lib/extension/protocol";
import { canonicalCompany, canonicalProfile, targetFromUrl } from "../urls";
import { firstText, headlineParts, safeAll, splitName } from "./text";

const NAME = ["[data-anonymize='person-name']", "[data-x--lead--name]", ".profile-topcard-person-entity__name", "main h1", "h1"];
const TITLE = ["[data-anonymize='job-title']", "[data-x--lead--title]", ".profile-topcard__current-positions [data-anonymize='title']"];
const HEADLINE = ["[data-anonymize='headline']", ".profile-topcard__summary-position", "[data-x--lead--headline]"];
const COMPANY = ["[data-anonymize='company-name']", "a[href*='/sales/company/']", "[data-x--lead--company]"];
const LOCATION = ["[data-anonymize='location']", ".profile-topcard__location-data", "[data-x--lead--location]"];

export function readLead(root: ParentNode, url: string): PagePerson {
  const names = splitName(firstText(root, NAME));
  const headline = firstText(root, HEADLINE);
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
    jobTitle: firstText(root, TITLE) ?? fromHeadline.jobTitle,
    location: firstText(root, LOCATION),
    linkedinUrl: canonicalProfile(profileHref, url),
    salesNavigatorUrl: target.kind === "lead" ? target.canonical : null,
    companyName: firstText(root, COMPANY) ?? fromHeadline.companyName,
    companyLinkedinUrl: canonicalCompany(companyHref, url),
  };
}
