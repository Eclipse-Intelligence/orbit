export const BRAND_LIMITS = {
  website: 300,
  whatYouSell: 6000,
  whoItsFor: 20000,
  tone: 3000,
  playbook: 60000,
  outreachBrief: 20000,
} as const;

export const FORMER_NAME_LIMITS = { count: 10, length: 80 } as const;

export function formerNamesFrom(value: unknown): string[] | null {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : null;
  if (!parts) return null;
  const names: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") return null;
    const name = part.trim().replace(/\s+/g, " ");
    if (name && !names.some((known) => known.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names;
}

export const OWN_DOMAIN_LIMITS = { count: 20, length: 100 } as const;

export function ownDomainParts(value: unknown): string[] | null {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,;]+/) : null;
  if (!parts) return null;
  const domains: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") return null;
    const domain = part.trim().toLowerCase().replace(/\s+/g, "").replace(/^.*@/, "");
    if (domain && !domains.includes(domain)) domains.push(domain);
  }
  return domains;
}

export type BrandProfileInput = {
  website: string;
  whatYouSell: string;
  whoItsFor: string;
  tone: string;
};

export type BrandPlaybookInput = {
  playbook: string;
  outreachBrief: string;
};

export type BrandProfile = BrandProfileInput &
  BrandPlaybookInput & {
    workspaceId: string;
    workspaceName: string;
    formerNames: string[];
    ownDomains: string[];
    playbookUpdatedAt: string | null;
    updatedAt: string | null;
    unread?: boolean;
  };

export type BrandDraft = {
  draft: Omit<BrandProfileInput, "website">;
  sources: string[];
  notes: string[];
};

export function brandIsEmpty(brand: Pick<BrandProfileInput, "website" | "whatYouSell" | "whoItsFor" | "tone">) {
  return !brand.website.trim() && !brand.whatYouSell.trim() && !brand.whoItsFor.trim() && !brand.tone.trim();
}
