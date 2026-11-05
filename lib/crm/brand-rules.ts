export const BRAND_LIMITS = {
  website: 300,
  whatYouSell: 6000,
  whoItsFor: 20000,
  tone: 3000,
  playbook: 60000,
  outreachBrief: 20000,
} as const;

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
    eclipseTools: boolean;
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
