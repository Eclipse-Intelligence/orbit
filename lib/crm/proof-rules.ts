export const PROOF_PERMISSIONS = ["named", "described", "reference"] as const;

export type ProofPermission = (typeof PROOF_PERMISSIONS)[number];

export const PERMISSION_LABEL: Record<ProofPermission, string> = {
  named: "Named",
  described: "Described only",
  reference: "Named, takes reference calls",
};

export const PROOF_LIMITS = { client: 120, description: 300, product: 80, usedFor: 300, result: 500, measured: 300, approvedBy: 120 } as const;

export function productSuggestions(entries: Pick<ProofEntry, "product">[], workspaceName: string) {
  const counts = new Map<string, { label: string; count: number }>();
  for (const entry of entries) {
    const label = entry.product.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    const current = counts.get(key);
    counts.set(key, { label: current?.label ?? label, count: (current?.count ?? 0) + 1 });
  }
  const used = [...counts.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)).map((item) => item.label);
  const name = workspaceName.trim();
  return name && !counts.has(name.toLowerCase()) ? [...used, name] : used;
}

export type ProofEntry = {
  id: string;
  client: string;
  description: string;
  product: string;
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
