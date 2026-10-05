import { CrmError } from "@/lib/crm/errors";

export const SCOPES = [
  "crm:read",
  "companies:write",
  "contacts:write",
  "leads:write",
  "activities:write",
  "opportunities:write",
  "tasks:write",
  "admin",
] as const;

export type Scope = (typeof SCOPES)[number];

const SCOPE_SET = new Set<string>(SCOPES);

export function isScope(value: string): value is Scope {
  return SCOPE_SET.has(value);
}

export function scopesForRole(role: "owner" | "admin" | "member"): Scope[] {
  if (role === "owner" || role === "admin") return [...SCOPES];
  return SCOPES.filter((scope) => scope !== "admin");
}

export function hasScope(scopes: readonly string[], required: Scope) {
  return scopes.includes("admin") || scopes.includes(required);
}

export function assertScope(scopes: readonly string[], required: Scope) {
  if (!hasScope(scopes, required)) {
    throw new CrmError(
      "forbidden",
      `Missing scope ${required}.`,
      403,
      { scope: required },
    );
  }
}
