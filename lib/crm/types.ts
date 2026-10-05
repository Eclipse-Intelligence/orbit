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
  lastInteractionAt: string | null;
  openTaskCount: number;
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

export const ACTIVITY_TYPES = [
  "email",
  "meeting",
  "call",
  "note",
  "research",
  "linkedin",
  "agent_update",
  "other",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const OPPORTUNITY_STATUSES = ["open", "won", "lost"] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "normal", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_VIEWS = ["overdue", "today", "upcoming", "completed", "none"] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

export type Contact = {
  id: string;
  workspaceId: string;
  companyId: string | null;
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  linkedinUrl: string | null;
  ownerId: string | null;
  ownerName: string | null;
  source: string | null;
  sourceReference: string | null;
  notes: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ContactWrite = {
  companyId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  linkedinUrl?: string | null;
  ownerId?: string | null;
  source?: string | null;
  sourceReference?: string | null;
  notes?: string | null;
};

export type ContactMatch = "email" | "linkedin" | "name";

export type ContactListQuery = {
  query?: string;
  companyId?: string;
  ownerId?: string | "unassigned";
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
};

export type PipelineStage = {
  id: string;
  pipelineId: string;
  name: string;
  position: number;
  probability: number;
  isWon: boolean;
  isLost: boolean;
};

export type Opportunity = {
  id: string;
  workspaceId: string;
  companyId: string;
  companyName: string | null;
  primaryContactId: string | null;
  primaryContactName: string | null;
  pipelineId: string | null;
  stageId: string | null;
  stageName: string | null;
  name: string;
  value: string | null;
  currency: string;
  probability: number | null;
  expectedCloseDate: string | null;
  ownerId: string | null;
  ownerName: string | null;
  status: OpportunityStatus;
  source: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OpportunityWrite = {
  companyId?: string;
  primaryContactId?: string | null;
  stageId?: string | null;
  name?: string;
  value?: string | number | null;
  currency?: string | null;
  probability?: number | null;
  expectedCloseDate?: string | null;
  ownerId?: string | null;
  status?: OpportunityStatus;
  source?: string | null;
};

export type OpportunityListQuery = {
  query?: string;
  companyId?: string;
  status?: OpportunityStatus;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
};

export type Activity = {
  id: string;
  workspaceId: string;
  type: ActivityType;
  title: string | null;
  body: string | null;
  occurredAt: string;
  companyId: string | null;
  companyName: string | null;
  contactId: string | null;
  contactName: string | null;
  opportunityId: string | null;
  opportunityName: string | null;
  actorUserId: string | null;
  actorAgentId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ActivityWrite = {
  type?: ActivityType;
  title?: string | null;
  body?: string | null;
  occurredAt?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type ActivityListQuery = {
  query?: string;
  companyId?: string;
  contactId?: string;
  opportunityId?: string;
  type?: ActivityType;
  limit?: number;
  offset?: number;
};

export type Task = {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  completedAt: string | null;
  priority: TaskPriority;
  ownerId: string | null;
  ownerName: string | null;
  companyId: string | null;
  companyName: string | null;
  contactId: string | null;
  contactName: string | null;
  opportunityId: string | null;
  opportunityName: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskWrite = {
  title?: string;
  description?: string | null;
  dueAt?: string | null;
  priority?: TaskPriority;
  ownerId?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
  completed?: boolean;
};

export type TaskListQuery = {
  query?: string;
  view?: TaskView;
  companyId?: string;
  ownerId?: string | "unassigned";
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
};

export type LeadInput = {
  company?: CompanyWrite;
  contact?: ContactWrite;
  note?: string | null;
  activity?: ActivityWrite;
  opportunity?: OpportunityWrite;
  task?: TaskWrite;
};

export type LeadResult = {
  company: Company | null;
  contact: Contact | null;
  activity: Activity | null;
  opportunity: Opportunity | null;
  task: Task | null;
  companyCreated: boolean;
  contactCreated: boolean;
  companyMatchedOn: "domain" | "name" | null;
  contactMatchedOn: ContactMatch | null;
};

export type RelationshipStatus = "new" | "active" | "quiet" | "needs_action";

export type CompanyContext = {
  company: Company;
  contacts: Contact[];
  opportunities: Opportunity[];
  activities: Activity[];
  tasks: Task[];
  lastInteraction: Activity | null;
  openTaskCount: number;
  relationshipStatus: RelationshipStatus;
};

export type StaleRelationship = {
  company: Company;
  lastActivityAt: string | null;
  openTaskCount: number;
  daysSinceActivity: number | null;
};

export type DueActions = {
  view: TaskView;
  tasks: Task[];
  companies: Company[];
};
