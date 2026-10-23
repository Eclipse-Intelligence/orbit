import type { Relationship } from "@/lib/crm/relationship-score";
import type { Scope } from "@/lib/crm/scopes";

export const LIFECYCLES = ["lead", "prospect", "customer", "churned"] as const;
export type BuiltInLifecycle = (typeof LIFECYCLES)[number];
export type Lifecycle = string;
export type LifecycleCount = { value: string; label: string; companies: number; builtIn: boolean };
export const ACCOUNT_HEALTH = ["healthy", "watch", "at_risk"] as const;
export type AccountHealth = (typeof ACCOUNT_HEALTH)[number];

export const COMPANY_SORTS = ["name", "domain", "updated", "created", "interaction", "strength", "owner"] as const;
export type CompanySort = (typeof COMPANY_SORTS)[number];

export const COMPANY_PRESENCE = ["domain", "contacts", "interactions"] as const;
export type CompanyPresence = (typeof COMPANY_PRESENCE)[number];

export const CONTACT_SORTS = ["name", "company", "updated", "created"] as const;
export type ContactSort = (typeof CONTACT_SORTS)[number];

export const CONTACT_PRESENCE = ["email", "phone", "linkedin", "company"] as const;
export type ContactPresence = (typeof CONTACT_PRESENCE)[number];

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

export type BrandLink = "careers" | "pricing" | "blog" | "contact" | "terms" | "privacy";

export type CompanyBrand = {
  slogan: string | null;
  socials: { type: string; url: string }[];
  links: Partial<Record<BrandLink, string>>;
  industries: { industry: string; subindustry: string | null }[];
  employees: { range: string | null; exact: number | null } | null;
  email: string | null;
  stock: { ticker: string; exchange: string | null } | null;
  colors: string[];
  backdropUrl: string | null;
  checkedAt: string;
};

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
  linkedinUrl: string | null;
  phone: string | null;
  address: string | null;
  logoUrl: string | null;
  enrichedAt: string | null;
  brand: CompanyBrand | null;
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
  relationship?: Relationship;
  openTaskCount: number;
  tags: string[];
  health: AccountHealth | null;
  healthReason: string | null;
  healthAt: string | null;
  healthActivityId: string | null;
};

export type CompanyWrite = {
  name?: string;
  domain?: string | null;
  website?: string | null;
  description?: string | null;
  industry?: string | null;
  sizeCategory?: string | null;
  linkedinUrl?: string | null;
  phone?: string | null;
  address?: string | null;
  logoUrl?: string | null;
  lifecycle?: Lifecycle;
  ownerId?: string | null;
  source?: string | null;
  sourceReference?: string | null;
  tags?: string[] | null;
  health?: AccountHealth | null;
  healthReason?: string | null;
};

export type Provenance = {
  operation: string;
  source?: string | null;
  sourceUrl?: string | null;
  workflowId?: string;
  depth?: number;
  catchUp?: boolean;
};

export type CompanyListQuery = {
  query?: string;
  lifecycle?: Lifecycle;
  health?: AccountHealth | "none";
  ownerId?: string | "unassigned";
  tag?: string;
  includeArchived?: boolean;
  sort?: CompanySort;
  order?: "asc" | "desc";
  has?: CompanyPresence[];
  missing?: CompanyPresence[];
  limit?: number;
  offset?: number;
  relationships?: boolean;
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

export const TASK_VIEWS = ["all", "overdue", "today", "upcoming", "completed", "none"] as const;
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
  tags: string[];
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
  tags?: string[] | null;
};

export type ContactMatch = "email" | "linkedin" | "name";

export type ContactListQuery = {
  query?: string;
  companyId?: string;
  ownerId?: string | "unassigned";
  tag?: string;
  includeArchived?: boolean;
  sort?: ContactSort;
  order?: "asc" | "desc";
  has?: ContactPresence[];
  missing?: ContactPresence[];
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

export type BoardKind = "sales" | "board";

export type Board = {
  id: string;
  name: string;
  kind: BoardKind;
  addOnWon: boolean;
  position: number;
  stages: PipelineStage[];
};

export type BoardSummary = Omit<Board, "stages"> & { count: number };

export type Opportunity = {
  id: string;
  workspaceId: string;
  companyId: string;
  companyName: string | null;
  companyHealth: AccountHealth | null;
  primaryContactId: string | null;
  primaryContactName: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
  pipelineKind: BoardKind | null;
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
  pipelineId?: string | null;
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
  pipelineId?: string;
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
  actorName: string | null;
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
  remindMinutes: number | null;
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
  clickupTaskId: string | null;
  clickupListId: string | null;
  clickupUrl: string | null;
  clickupError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskWrite = {
  title?: string;
  description?: string | null;
  dueAt?: string | null;
  remindMinutes?: number | null;
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
  mine?: boolean;
  companyId?: string;
  contactId?: string;
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

export const CALL_INSIGHT_SOURCES = ["teams", "manual", "granola"] as const;
export type CallInsightSource = (typeof CALL_INSIGHT_SOURCES)[number];
export type CallInsightStatus = "pending" | "ready" | "failed";
export const CALL_INSIGHT_STALE_MS = 3 * 60 * 1000;
export type CallActionOwner = "me" | "them";
export type CallActionStatus = "suggested" | "accepted" | "dismissed";

export type CallActionItem = {
  id: string;
  title: string;
  owner: CallActionOwner | null;
  dueDate: string | null;
  status: CallActionStatus;
  taskId: string | null;
};

export type CallInsight = {
  id: string;
  workspaceId: string;
  activityId: string;
  contactId: string | null;
  companyId: string | null;
  source: CallInsightSource;
  summary: string | null;
  keyPoints: string[];
  actionItems: CallActionItem[];
  model: string | null;
  status: CallInsightStatus;
  error: string | null;
  sentiment: AccountHealth | null;
  sentimentReason: string | null;
  transcriptLength: number;
  createdAt: string;
  updatedAt: string;
};

export type CompanyContext = {
  company: Company;
  contacts: Contact[];
  opportunities: Opportunity[];
  activities: Activity[];
  timeline: Activity[];
  insights: Record<string, CallInsight>;
  tasks: Task[];
  lastInteraction: Activity | null;
  openTaskCount: number;
  relationshipStatus: RelationshipStatus;
  relationship: Relationship;
};

export type StaleRelationship = {
  company: Company;
  lastActivityAt: string | null;
  openTaskCount: number;
  daysSinceActivity: number | null;
};

export type TagKind = "contact" | "company";

export type TagCount = {
  name: string;
  contacts: number;
  companies: number;
};

export type DueActions = {
  view: TaskView;
  tasks: Task[];
  companies: Company[];
};
