export const DEFAULT_ADDRESS = "orbit@ai-mail.geteclipse.co";
export const DEFAULT_SENDERS = ["mark@geteclipse.co", "mark@ridgeon.me"];

const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "net.nz",
  "co.jp", "ne.jp", "or.jp",
  "co.za", "org.za",
  "com.br", "com.cn", "com.mx", "com.sg", "com.hk", "com.tr", "co.in", "co.il", "co.kr",
]);

export type AuthenticationResults = {
  spf?: string;
  spf_domain?: string;
  dkim?: string;
  dkim_domain?: string;
  dmarc?: string;
  dmarc_domain?: string;
};

export function bareAddress(value: unknown) {
  if (typeof value !== "string") return null;
  const angle = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value.trim());
  const candidate = (angle ? angle[1] : value).trim().toLowerCase();
  return /^[^@\s<>"(),;:]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(candidate) ? candidate : null;
}

export function displayName(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /^\s*"?([^"<]*?)"?\s*<[^<>]+>\s*$/.exec(value);
  const name = match?.[1]?.trim();
  return name ? name.slice(0, 300) : null;
}

export function domainOf(address: string) {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

export function organisationalDomain(domain: string) {
  const labels = domain.toLowerCase().replace(/\.+$/, "").split(".").filter(Boolean);
  if (labels.length < 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return labels.length >= 3 ? labels.slice(-3).join(".") : lastTwo;
  return lastTwo;
}

export function aligned(a: string | undefined | null, b: string | undefined | null) {
  if (!a || !b) return false;
  const left = organisationalDomain(a);
  const right = organisationalDomain(b);
  if (!left.includes(".") || !right.includes(".")) return false;
  if (MULTI_PART_SUFFIXES.has(left) || MULTI_PART_SUFFIXES.has(right)) return false;
  return left === right;
}

export function senderAuthenticated(from: string, auth: AuthenticationResults | null | undefined) {
  if (!auth || typeof auth !== "object") return false;
  const fromDomain = domainOf(from);
  const dmarc = typeof auth.dmarc === "string" ? auth.dmarc.toLowerCase() : "";
  const dkim = typeof auth.dkim === "string" ? auth.dkim.toLowerCase() : "";
  if (dmarc === "fail") return false;
  const dmarcDomain = typeof auth.dmarc_domain === "string" ? auth.dmarc_domain.toLowerCase() : null;
  if (dmarc === "pass" && (!dmarcDomain || dmarcDomain === fromDomain)) return true;
  return dkim === "pass" && aligned(typeof auth.dkim_domain === "string" ? auth.dkim_domain : null, fromDomain);
}

export type MailVerdict = { actionable: boolean; reason: string | null };

const UNSAFE_LEVELS = new Set(["suspicious", "quarantined"]);

export function judgeMail(input: {
  eventType: string;
  direction: unknown;
  from: string | null;
  auth: AuthenticationResults | null | undefined;
  trustLevel: unknown;
}): MailVerdict {
  if (input.eventType !== "message.received") return { actionable: false, reason: `MachineMail sent it as ${input.eventType.slice(0, 60)}, so Orbit didn't act on it.` };
  if (input.direction !== undefined && input.direction !== "inbound") return { actionable: false, reason: "It wasn't an incoming email." };
  if (!input.from) return { actionable: false, reason: "The sender's address couldn't be read." };
  if (!senderAuthenticated(input.from, input.auth)) {
    return { actionable: false, reason: "It didn't pass email authentication for the sender's domain (DMARC, or DKIM aligned with it), so it could be spoofed." };
  }
  if (typeof input.trustLevel === "string" && UNSAFE_LEVELS.has(input.trustLevel)) {
    return { actionable: false, reason: `MachineMail rated it ${input.trustLevel}.` };
  }
  return { actionable: true, reason: null };
}

export function normaliseSender(value: unknown) {
  return bareAddress(typeof value === "string" ? value : "");
}
