export const DEFAULT_ADDRESS = "orbit@ai-mail.geteclipse.co";

export type AuthenticationResults = {
  spf?: string;
  spf_domain?: string;
  dkim?: string;
  dkim_domain?: string;
  dmarc?: string;
  dmarc_domain?: string;
};

const ADDRESS = /^[^@\s<>"(),;:]+@[a-z0-9.-]+\.[a-z]{2,}$/;

export function bareAddress(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if ((trimmed.match(/@/g) ?? []).length !== 1) return null;
  const angle = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(trimmed);
  const candidate = (angle ? angle[1] : trimmed).toLowerCase();
  return ADDRESS.test(candidate) ? candidate : null;
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

function clean(domain: string) {
  return domain.toLowerCase().replace(/\.+$/, "");
}

export function aligned(a: string | undefined | null, b: string | undefined | null) {
  if (!a || !b) return false;
  const left = clean(a);
  const right = clean(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const [longer, shorter] = left.length > right.length ? [left, right] : [right, left];
  return shorter.includes(".") && longer.endsWith(`.${shorter}`);
}

export function senderAuthenticated(from: string, auth: AuthenticationResults | null | undefined, trustAligned?: boolean | null) {
  if (!auth || typeof auth !== "object") return false;
  if (trustAligned === false) return false;
  const fromDomain = domainOf(from);
  const dmarc = typeof auth.dmarc === "string" ? auth.dmarc.toLowerCase() : "";
  const dkim = typeof auth.dkim === "string" ? auth.dkim.toLowerCase() : "";
  if (dmarc === "fail") return false;
  const dmarcDomain = typeof auth.dmarc_domain === "string" ? clean(auth.dmarc_domain) : null;
  if (dmarc === "pass" && (!dmarcDomain || dmarcDomain === fromDomain)) return true;
  return dkim === "pass" && aligned(typeof auth.dkim_domain === "string" ? auth.dkim_domain : null, fromDomain);
}

export type MailVerdict = { actionable: boolean; reason: string | null };

const SAFE_LEVELS = new Set(["verified", "known", "unknown"]);

export function quarantinedForInstructionsOnly(reasons: unknown) {
  const list = Array.isArray(reasons) ? reasons.filter((reason): reason is string => typeof reason === "string") : [];
  const quarantine = list.filter((reason) => /^\s*quarantined:/i.test(reason));
  if (quarantine.length === 0 || !quarantine.every((reason) => /instructions-to-agent/i.test(reason))) return false;
  return !list.some((reason) => /malware|virus(?!\s+pass)/i.test(reason));
}

const FILED_AS: Record<string, string> = {
  "message.received.spam": "MachineMail filed it as spam.",
  "message.received.quarantined": "MachineMail quarantined it.",
  "message.received.unauthenticated": "It failed email authentication (DMARC, or both SPF and DKIM).",
  "message.received.blocked": "The sender is on MachineMail's block list.",
};

export function judgeMail(input: {
  eventType: string;
  direction: unknown;
  from: string | null;
  inbox: string;
  auth: AuthenticationResults | null | undefined;
  trustAligned?: boolean | null;
  trustLevel: unknown;
  instructionsOnly?: boolean;
}): MailVerdict {
  const instructions = input.instructionsOnly === true && input.trustLevel === "quarantined";
  if (input.eventType !== "message.received" && !(instructions && input.eventType === "message.received.quarantined")) {
    return { actionable: false, reason: FILED_AS[input.eventType] ?? `MachineMail sent it as ${input.eventType.slice(0, 60)}, so Orbit didn't act on it.` };
  }
  if (input.direction !== "inbound") return { actionable: false, reason: "It wasn't marked as an incoming email." };
  if (!input.from) return { actionable: false, reason: "The sender's address couldn't be read, or there was more than one." };
  if (input.from === input.inbox) return { actionable: false, reason: "It came from the agent mailbox itself." };
  if (typeof input.trustLevel !== "string" || !input.trustLevel) return { actionable: false, reason: "It had no trust report from MachineMail." };
  if (!SAFE_LEVELS.has(input.trustLevel) && !instructions) return { actionable: false, reason: `MachineMail rated it ${input.trustLevel.slice(0, 40)}.` };
  if (!senderAuthenticated(input.from, input.auth, input.trustAligned)) {
    return { actionable: false, reason: "It didn't pass email authentication for the sender's domain (DMARC, or DKIM for that domain), so it could be spoofed." };
  }
  return { actionable: true, reason: null };
}
