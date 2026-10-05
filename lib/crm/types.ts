import type { Scope } from "@/lib/crm/scopes";

export const LIFECYCLES = ["lead", "prospect", "customer", "churned"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export const COMPANY_SORTS = ["name", "domain", "updated", "created"] as const;
export type CompanySort = (typeof COMPANY_SORTS)[number];

export type WorkspaceRole = "owner" | "admin" | "member";

export type UserActor = {
  type: "user";
  userId: string;
  email: string;
  fullName: string | null;
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  scopes: Scope[];
};

export type AgentActor = {
  type: "agent";
  agentId: string;
  agentName: string;
  credentialId: string;
  workspaceId: string;
  scopes: Scope[];
};

export type Actor = UserActor | AgentActor;

export type Company = {
  id: string;
  workspaceId: string;
  name: string;
  normalizedName: string;
  domain: string | null;
  website: string | null;
  description: string | null;
  industry: string | null;
  sizeCategory: string | null;
  lifecycle: Lifecycle;
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  source: string | null;
  sourceReference: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CompanyWrite = {
  name?: string;
  domain?: string | null;
  website?: string | null;
  description?: string | null;
  industry?: string | null;
  sizeCategory?: string | null;
  lifecycle?: Lifecycle;
  ownerId?: string | null;
  source?: string | null;
  sourceReference?: string | null;
};

export type Provenance = {
  operation: string;
  source?: string | null;
  sourceUrl?: string | null;
};

export type CompanyListQuery = {
  query?: string;
  lifecycle?: Lifecycle;
  ownerId?: string | "unassigned";
  includeArchived?: boolean;
  sort?: CompanySort;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

export type Member = {
  id: string;
  name: string;
  email: string | null;
  role: WorkspaceRole;
};

export type UpsertResult = {
  company: Company;
  created: boolean;
  matchedOn: "domain" | "name" | null;
};

export type BulkItemResult = {
  index: number;
  status: "created" | "updated" | "matched" | "error";
  company?: Company;
  matchedOn?: "domain" | "name" | null;
  error?: { code: string; message: string };
};
