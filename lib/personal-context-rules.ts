export const PERSONAL_LIMITS = {
  jobTitle: 120,
  about: 3000,
  interests: 3000,
  writing: 1500,
  url: 300,
} as const;

export type PersonalContextInput = {
  jobTitle: string;
  about: string;
  interests: string;
  writing: string;
  linkedinUrl: string;
  websiteUrl: string;
};

export function normaliseWebsite(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true as const, url: null };
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".") || candidate.length > PERSONAL_LIMITS.url) throw new Error();
    return { ok: true as const, url: url.href.replace(/\/$/, "") };
  } catch {
    return { ok: false as const, error: "Enter your website address, for example ridgeon.me." };
  }
}

export function normaliseLinkedIn(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true as const, url: null };
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`;
  const match = candidate.match(/^https?:\/\/(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%]+)\/?(?:[?#].*)?$/i);
  if (!match || candidate.length > PERSONAL_LIMITS.url) {
    return { ok: false as const, error: "Enter your LinkedIn profile link, for example linkedin.com/in/your-name." };
  }
  return { ok: true as const, url: `https://www.linkedin.com/in/${match[1]}` };
}
