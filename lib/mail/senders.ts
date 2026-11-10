import { isFreeMailDomain } from "@/lib/crm/communications";
import { AUTOMATED_SENDER } from "@/lib/mail/split";

export type ListedCategory = "supplier" | "service" | "personal" | "collections";

export const LISTED_SENDERS: Record<ListedCategory, string[]> = {
  service: [
    "google.com",
    "youtube.com",
    "microsoft.com",
    "microsoftonline.com",
    "office.com",
    "office365.com",
    "linkedin.com",
    "apple.com",
    "amazon.com",
    "amazon.co.uk",
    "amazonaws.com",
    "facebook.com",
    "facebookmail.com",
    "meta.com",
    "instagram.com",
    "x.com",
    "twitter.com",
    "docusign.net",
    "docusign.com",
    "godaddy.com",
    "namecheap.com",
    "squarespace.com",
    "wix.com",
    "royalmail.com",
    "parcelforce.com",
    "dhl.com",
    "dhl.co.uk",
    "ups.com",
    "fedex.com",
    "dpd.co.uk",
    "dpd.com",
    "evri.com",
    "hermes-europe.co.uk",
    "yodel.co.uk",
    "uber.com",
    "ubereats.com",
    "deliveroo.co.uk",
    "trainline.com",
    "booking.com",
    "airbnb.com",
  ],
  supplier: [
    "stripe.com",
    "paypal.com",
    "paypal.co.uk",
    "xero.com",
    "quickbooks.com",
    "intuit.com",
    "sage.com",
    "freeagent.com",
    "gocardless.com",
    "chargebee.com",
    "paddle.com",
    "invoice2go.com",
    "bt.com",
    "btinternet.com",
    "ee.co.uk",
    "vodafone.co.uk",
    "vodafone.com",
    "o2.co.uk",
    "three.co.uk",
    "virginmedia.com",
    "virginmedia.co.uk",
    "sky.com",
    "talktalk.co.uk",
    "plus.net",
    "britishgas.co.uk",
    "octopus.energy",
    "edfenergy.com",
    "eonenergy.com",
    "eon.co.uk",
    "ovoenergy.com",
    "scottishpower.co.uk",
    "thameswater.co.uk",
    "regus.com",
    "iwgplc.com",
    "wework.com",
  ],
  personal: [
    "nhs.uk",
    "nhs.net",
    "gov.uk",
    "barclays.co.uk",
    "barclays.com",
    "barclaycard.co.uk",
    "hsbc.co.uk",
    "hsbc.com",
    "lloydsbank.co.uk",
    "lloydsbank.com",
    "natwest.com",
    "rbs.co.uk",
    "santander.co.uk",
    "nationwide.co.uk",
    "halifax.co.uk",
    "tsb.co.uk",
    "metrobankonline.co.uk",
    "monzo.com",
    "starlingbank.com",
    "revolut.com",
    "tide.co",
    "wise.com",
    "amex.co.uk",
    "americanexpress.com",
    "aexp.com",
    "aviva.co.uk",
    "aviva.com",
    "axa.co.uk",
    "directline.com",
    "admiral.com",
    "lv.com",
    "legalandgeneral.com",
    "bupa.co.uk",
    "bupa.com",
    "vitality.co.uk",
    "axahealth.co.uk",
    "simplyhealth.co.uk",
    "humanhealth.co.uk",
    "boots.com",
    "specsavers.com",
    "mydentist.co.uk",
    "livi.co.uk",
    "pensionbee.com",
    "vanguardinvestor.co.uk",
    "hl.co.uk",
    "ajbell.co.uk",
    "experian.co.uk",
    "equifax.co.uk",
    "clearscore.com",
    "rightmove.co.uk",
    "zoopla.co.uk",
  ],
  collections: [
    "lowell.co.uk",
    "lowellgroup.co.uk",
    "cabotfinancial.co.uk",
    "intrum.co.uk",
    "intrum.com",
    "moorcroftgroup.com",
    "pra-group.co.uk",
    "pragroup.co.uk",
    "hoistfinance.co.uk",
    "arrowglobal.net",
    "wescot.co.uk",
    "robinsonway.com",
    "bwlegal.co.uk",
    "cclcollect.co.uk",
    "zinccredit.co.uk",
    "advantis.co.uk",
    "creditresourcesolutions.co.uk",
    "highcourtenforcement.co.uk",
    "marstongroup.co.uk",
    "equita.co.uk",
    "bristow-sutor.co.uk",
    "dcbllegal.co.uk",
  ],
};

const LISTED_SUFFIXES: [string, ListedCategory][] = [
  [".nhs.uk", "personal"],
  [".nhs.net", "personal"],
  [".gov.uk", "personal"],
  [".police.uk", "personal"],
];

const LISTED = new Map<string, ListedCategory>(
  (Object.entries(LISTED_SENDERS) as [ListedCategory, string[]][]).flatMap(([category, domains]) => domains.map((domain) => [domain, category] as const)),
);

export function domainOf(email: string) {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

export function listedCategory(email: string): ListedCategory | null {
  const domain = domainOf(email);
  if (!domain || isFreeMailDomain(domain)) return null;
  const labels = domain.split(".");
  for (let index = 0; index < labels.length - 1; index += 1) {
    const found = LISTED.get(labels.slice(index).join("."));
    if (found) return found;
  }
  return LISTED_SUFFIXES.find(([suffix]) => domain.endsWith(suffix))?.[1] ?? null;
}

type Header = { name: string; value: string };

export function bulkHeaderCategory(headers: Header[]): "newsletter" | "service" | null {
  const value = (name: string) => headers.find((header) => header.name.toLowerCase() === name)?.value.trim().toLowerCase() ?? null;
  const precedence = value("precedence");
  if (precedence && /^(bulk|list|junk)\b/.test(precedence)) return "newsletter";
  if (value("list-id")) return "newsletter";
  const auto = value("auto-submitted");
  if (auto && auto !== "no") return "service";
  return null;
}

export const MEETING_TOOL_DOMAIN =
  "[.@](calendly[.]com|zoom[.]us|zoom[.]com|zoomgov[.]com|savvycal[.]com|cal[.]com|chilipiper[.]com|acuityscheduling[.]com|doodle[.]com|youcanbook[.]me|meetings[.]hubspot[.]com|googlegroups[.]com|calendar[.]google[.]com|calendar[.]icloud[.]com|teams[.]microsoft[.]com)$";

export const MEETING_RESOURCE_LOCAL =
  "^(rooms?|conf|conference|conference-?rooms?|meeting-?rooms?|meetingroom|boardroom|board-?room|resources?|calendar|bookings?|scheduling|scheduler|zoom-?rooms?|zoomroom|teams-?rooms?|mtr|everyone|allstaff|all-staff|staff|group|events?)([._+-][^@]*)?@";

const MEETING_NOISE = [MEETING_TOOL_DOMAIN, MEETING_RESOURCE_LOCAL, AUTOMATED_SENDER];

export function isMeetingNoise(email: string) {
  const address = email.toLowerCase();
  return MEETING_NOISE.some((pattern) => new RegExp(pattern, "i").test(address));
}

export function meetingNoiseSql(column: string) {
  return `(${MEETING_NOISE.map((pattern) => `${column} ~* '${pattern}'`).join(" or ")})`;
}
