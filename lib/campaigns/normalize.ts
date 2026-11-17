import { canonicalEmail, canonicalLinkedin, normalizedLinkedin } from "@/lib/crm/normalize";

export function prospectEmail(value: string | null | undefined) {
  return value ? canonicalEmail(value) : null;
}

export function prospectLinkedin(value: string | null | undefined) {
  const url = value ? canonicalLinkedin(value) : null;
  return url ? normalizedLinkedin(url) : null;
}

export function splitName(value: string | null | undefined) {
  const parts = (value ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") || null };
}
