export const PROOF_PRODUCTS = ["eclipse", "cntent"] as const;
export const PROOF_PERMISSIONS = ["named", "described", "reference"] as const;

export type ProofProduct = (typeof PROOF_PRODUCTS)[number];
export type ProofPermission = (typeof PROOF_PERMISSIONS)[number];

export const PRODUCT_LABEL: Record<ProofProduct, string> = { eclipse: "Eclipse", cntent: "Cntent" };

export const PERMISSION_LABEL: Record<ProofPermission, string> = {
  named: "Named",
  described: "Described only",
  reference: "Named, takes reference calls",
};

export const PROOF_LIMITS = { client: 120, description: 300, usedFor: 300, result: 500, measured: 300, approvedBy: 120 } as const;

export type ProofEntry = {
  id: string;
  client: string;
  description: string;
  product: ProofProduct;
  usedFor: string;
  result: string;
  measured: string;
  permission: ProofPermission;
  approvedBy: string;
  reviewOn: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProofWrite = {
  client: string;
  description?: string;
  product?: string;
  usedFor?: string;
  result: string;
  measured?: string;
  permission: string;
  approvedBy?: string;
  reviewOn?: string | null;
};

export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function reviewOverdue(entry: Pick<ProofEntry, "reviewOn">, today = todayIso()) {
  return Boolean(entry.reviewOn && entry.reviewOn < today);
}
