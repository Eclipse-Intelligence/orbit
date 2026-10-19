import { z } from "zod";

export const TRIGGER_TYPES = [
  "call_summary_ready",
  "record_created",
  "field_changed",
  "stage_changed",
  "added_to_board",
  "activity_logged",
  "task_completed",
  "manual",
  "schedule",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const STEP_TYPES = [
  "ai",
  "if",
  "filter",
  "loop",
  "delay",
  "approval",
  "create_task",
  "add_note",
  "update_record",
  "board",
  "notify",
  "send_email",
  "linear_issue",
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const RECORD_OBJECTS = ["company", "contact"] as const;
export type RecordObject = (typeof RECORD_OBJECTS)[number];

export const CONDITION_OPS = [
  "is",
  "is_not",
  "contains",
  "not_contains",
  "is_empty",
  "is_not_empty",
  "greater_than",
  "less_than",
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export const AI_OUTPUT_TYPES = ["text", "number", "boolean", "list", "choice"] as const;
export type AiOutputType = (typeof AI_OUTPUT_TYPES)[number];

export const AI_MODELS = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fast)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (strongest)" },
] as const;

export const FIELD_OPTIONS: Record<RecordObject, { key: string; label: string }[]> = {
  company: [
    { key: "lifecycle", label: "Lifecycle" },
    { key: "ownerId", label: "Owner" },
    { key: "industry", label: "Industry" },
    { key: "sizeCategory", label: "Size" },
    { key: "source", label: "Source" },
    { key: "description", label: "Description" },
  ],
  contact: [
    { key: "ownerId", label: "Owner" },
    { key: "jobTitle", label: "Job title" },
    { key: "companyId", label: "Company" },
    { key: "source", label: "Source" },
    { key: "notes", label: "Notes" },
  ],
};

const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("call_summary_ready"), mine: z.boolean().optional() }),
  z.object({ type: z.literal("record_created"), object: z.enum(RECORD_OBJECTS), mine: z.boolean().optional() }),
  z.object({
    type: z.literal("field_changed"),
    object: z.enum(RECORD_OBJECTS),
    field: z.string().min(1).max(60),
    to: z.string().max(200).nullable().optional(),
    mine: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("stage_changed"),
    pipelineId: z.uuid().nullable().optional(),
    stageId: z.uuid().nullable().optional(),
    mine: z.boolean().optional(),
  }),
  z.object({ type: z.literal("added_to_board"), boardId: z.uuid(), mine: z.boolean().optional() }),
  z.object({
    type: z.literal("activity_logged"),
    activityType: z.enum(["call", "email", "meeting", "note"]).nullable().optional(),
    mine: z.boolean().optional(),
  }),
  z.object({ type: z.literal("task_completed"), mine: z.boolean().optional() }),
  z.object({ type: z.literal("manual"), object: z.enum(RECORD_OBJECTS) }),
  z.object({
    type: z.literal("schedule"),
    frequency: z.enum(["daily", "weekly"]),
    weekday: z.number().int().min(0).max(6).nullable().optional(),
    time: z.string().regex(/^\d{2}:\d{2}$/),
  }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

type LegacyStep = {
  id: string;
  type: StepType;
  label?: string;
  config: Record<string, unknown>;
  then?: LegacyStep[];
  else?: LegacyStep[];
  body?: LegacyStep[];
};

const STEP_ID = /^[a-z][a-z0-9_]{0,39}$/;

const legacyStepSchema: z.ZodType<LegacyStep> = z.lazy(() =>
  z.object({
    id: z.string().regex(STEP_ID),
    type: z.enum(STEP_TYPES),
    label: z.string().max(120).optional(),
    config: z.record(z.string(), z.unknown()),
    then: z.array(legacyStepSchema).max(50).optional(),
    else: z.array(legacyStepSchema).max(50).optional(),
    body: z.array(legacyStepSchema).max(50).optional(),
  }),
);

const legacySchema = z.object({ trigger: triggerSchema, steps: z.array(legacyStepSchema).max(50) });

const position = z.object({ x: z.number().finite(), y: z.number().finite() });

const nodeSchema = z.object({
  id: z.string().regex(STEP_ID),
  type: z.enum(STEP_TYPES),
  label: z.string().max(120).optional(),
  config: z.record(z.string(), z.unknown()),
  position,
});

const edgeSchema = z.object({
  source: z.string().max(40),
  handle: z.string().max(10),
  target: z.string().regex(STEP_ID),
});

export const definitionSchema = z.object({
  version: z.literal(2),
  trigger: triggerSchema,
  triggerPosition: position,
  nodes: z.array(nodeSchema).max(60),
  edges: z.array(edgeSchema).max(200),
});

export type WorkflowNode = z.infer<typeof nodeSchema>;
export type WorkflowEdge = z.infer<typeof edgeSchema>;
export type WorkflowDefinition = z.infer<typeof definitionSchema>;
export type Step = WorkflowNode;

export const TRIGGER_NODE = "trigger";

export function outputHandles(type: StepType | typeof TRIGGER_NODE): string[] {
  if (type === "if") return ["true", "false"];
  if (type === "loop") return ["each", "done"];
  return ["out"];
}

export const HANDLE_LABELS: Record<string, string> = { true: "Yes", false: "No", each: "Each item", done: "Done" };

export function graphProblem(definition: WorkflowDefinition): string | null {
  const ids = new Set(definition.nodes.map((node) => node.id));
  if (ids.size !== definition.nodes.length) return "Two nodes share the same id.";
  if (ids.has(TRIGGER_NODE)) return "A node can't be called trigger.";
  const types = new Map<string, StepType | typeof TRIGGER_NODE>(definition.nodes.map((node) => [node.id, node.type]));
  types.set(TRIGGER_NODE, TRIGGER_NODE);
  const used = new Set<string>();
  for (const edge of definition.edges) {
    const type = types.get(edge.source);
    if (!type) return "A connection starts from a node that doesn't exist.";
    if (!ids.has(edge.target)) return "A connection goes to a node that doesn't exist.";
    if (edge.source === edge.target) return "A node can't connect to itself.";
    if (!outputHandles(type).includes(edge.handle)) return "A connection uses an output the node doesn't have.";
    const key = `${edge.source}:${edge.handle}`;
    if (used.has(key)) return "An output can only connect to one node.";
    used.add(key);
  }
  const next = new Map<string, string[]>();
  for (const edge of definition.edges) next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target]);
  const state = new Map<string, number>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const target of next.get(id) ?? []) if (visit(target)) return true;
    state.set(id, 2);
    return false;
  };
  for (const id of [TRIGGER_NODE, ...ids]) if (visit(id)) return "Connections can't loop back. Use For each item to repeat steps.";
  return null;
}

export function nextNode(definition: WorkflowDefinition, source: string, handle: string) {
  return definition.edges.find((edge) => edge.source === source && edge.handle === handle)?.target ?? null;
}

export function ancestors(definition: WorkflowDefinition, nodeId: string) {
  const found = new Set<string>();
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of definition.edges) {
      if (edge.target === current && edge.source !== TRIGGER_NODE && !found.has(edge.source)) {
        found.add(edge.source);
        queue.push(edge.source);
      }
    }
  }
  return found;
}

const COLUMN = 280;
const ROW = 140;

export function autoLayout(definition: WorkflowDefinition): WorkflowDefinition {
  const depth = new Map<string, number>([[TRIGGER_NODE, 0]]);
  const order: string[] = [];
  const walk = (id: string, level: number) => {
    if ((depth.get(id) ?? -1) >= level && id !== TRIGGER_NODE) return;
    depth.set(id, level);
    if (!order.includes(id)) order.push(id);
    const type = id === TRIGGER_NODE ? TRIGGER_NODE : definition.nodes.find((node) => node.id === id)?.type;
    if (!type) return;
    for (const handle of outputHandles(type)) {
      const target = nextNode(definition, id, handle);
      if (target) walk(target, level + 1);
    }
  };
  walk(TRIGGER_NODE, 0);
  for (const node of definition.nodes) if (!depth.has(node.id)) {
    depth.set(node.id, 1);
    order.push(node.id);
  }
  const rows = new Map<number, number>();
  const place = new Map<string, { x: number; y: number }>();
  for (const id of order) {
    const level = depth.get(id) ?? 0;
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    place.set(id, { x: row * COLUMN, y: level * ROW });
  }
  return {
    ...definition,
    triggerPosition: place.get(TRIGGER_NODE) ?? { x: 0, y: 0 },
    nodes: definition.nodes.map((node) => ({ ...node, position: place.get(node.id) ?? node.position })),
  };
}

function fromLegacy(legacy: z.infer<typeof legacySchema>): WorkflowDefinition {
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  type Exit = { source: string; handle: string };
  const chain = (steps: LegacyStep[], entries: Exit[]): Exit[] => {
    let open = entries;
    for (const step of steps) {
      nodes.push({ id: step.id, type: step.type, ...(step.label ? { label: step.label } : {}), config: step.config, position: { x: 0, y: 0 } });
      for (const entry of open) edges.push({ ...entry, target: step.id });
      if (step.type === "if") {
        open = [...chain(step.then ?? [], [{ source: step.id, handle: "true" }]), ...chain(step.else ?? [], [{ source: step.id, handle: "false" }])];
      } else if (step.type === "loop") {
        chain(step.body ?? [], [{ source: step.id, handle: "each" }]);
        open = [{ source: step.id, handle: "done" }];
      } else {
        open = [{ source: step.id, handle: "out" }];
      }
    }
    return open;
  };
  chain(legacy.steps, [{ source: TRIGGER_NODE, handle: "out" }]);
  return autoLayout({ version: 2, trigger: legacy.trigger, triggerPosition: { x: 0, y: 0 }, nodes, edges });
}

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  call_summary_ready: "A call summary is ready",
  record_created: "A record is created",
  field_changed: "A field changes",
  stage_changed: "A deal or card changes stage",
  added_to_board: "A company is added to a board",
  activity_logged: "An activity is logged",
  task_completed: "A task is completed",
  manual: "Run from a record",
  schedule: "On a schedule",
};

export const STEP_LABELS: Record<StepType, string> = {
  ai: "Ask AI",
  if: "If",
  filter: "Continue only if",
  loop: "For each item",
  delay: "Wait",
  approval: "Wait for approval",
  create_task: "Create task",
  add_note: "Add note",
  update_record: "Update record",
  board: "Add to or move on a board",
  notify: "Notify someone",
  send_email: "Send email",
  linear_issue: "Create Linear issue",
};

export const STEP_HINTS: Record<StepType, string> = {
  ai: "Prompt an LLM and get back named fields you can use in later steps.",
  if: "Go one way or another depending on a condition.",
  filter: "Stop here unless a condition is true.",
  loop: "Repeat steps for each item in a list, such as each risk the AI found.",
  delay: "Pause for minutes, hours or days.",
  approval: "Pause until you approve or reject in Orbit.",
  create_task: "Create a task, optionally in ClickUp.",
  add_note: "Log a note on the company or contact.",
  update_record: "Change a field on the company or contact.",
  board: "Put the company on a board, or move its card to a stage.",
  notify: "Send an in-app notification.",
  send_email: "Email the contact from your Outlook.",
  linear_issue: "Create an issue in Linear.",
};

export function safeDefinition(value: unknown): WorkflowDefinition | null {
  const parsed = definitionSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const legacy = legacySchema.safeParse(value);
  return legacy.success ? fromLegacy(legacy.data) : null;
}

export function eventTriggerTypes(eventType: string, entityType: string, changes: Record<string, unknown>): TriggerType[] {
  if (eventType === "call_summary.ready") return ["call_summary_ready"];
  if (eventType === "company.created" || eventType === "contact.created") return ["record_created"];
  if (eventType === "company.updated" || eventType === "contact.updated") return ["field_changed"];
  if (eventType === "opportunity.stage_changed") return ["stage_changed"];
  if (eventType === "opportunity.created") {
    const after = (changes.after ?? {}) as { pipelineKind?: string };
    return after.pipelineKind === "board" ? ["added_to_board"] : [];
  }
  if (eventType === "activity.created" && entityType === "activity") return ["activity_logged"];
  if (eventType === "task.completed") return ["task_completed"];
  return [];
}

export function nextScheduleRun(trigger: Extract<Trigger, { type: "schedule" }>, after: Date, timeZone: string) {
  const [hour, minute] = trigger.time.split(":").map(Number);
  for (let offset = 0; offset < 9; offset += 1) {
    const day = new Date(after.getTime() + offset * 86_400_000);
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
      })
        .formatToParts(day)
        .map((part) => [part.type, part.value]),
    );
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
    if (trigger.frequency === "weekly" && weekday !== (trigger.weekday ?? 1)) continue;
    const candidate = zonedTime(Number(parts.year), Number(parts.month), Number(parts.day), hour, minute, timeZone);
    if (candidate > after) return candidate;
  }
  return new Date(after.getTime() + 86_400_000);
}

function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const shown = new Date(guess.toLocaleString("en-US", { timeZone }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() - (shown.getTime() - utc.getTime()));
}

export function newStepId(type: StepType, existing: string[]) {
  const base = type;
  for (let index = 1; index < 500; index += 1) {
    const id = `${base}_${index}`;
    if (!existing.includes(id)) return id;
  }
  return `${base}_${Date.now()}`;
}

export function definitionFromInput(value: unknown): { definition: WorkflowDefinition } | { error: string } {
  if (!value || typeof value !== "object") return { error: "Send a definition with a trigger and steps." };
  const input = value as { nodes?: unknown; steps?: unknown; triggerPosition?: unknown; edges?: unknown };
  if (Array.isArray(input.nodes)) {
    const nodes = input.nodes as Record<string, unknown>[];
    const placed = {
      ...input,
      version: 2,
      triggerPosition: input.triggerPosition ?? { x: 0, y: 0 },
      edges: Array.isArray(input.edges) ? input.edges : [],
      nodes: nodes.map((node) => ({ config: {}, ...node, position: node.position ?? { x: 0, y: 0 } })),
    };
    const parsed = definitionSchema.safeParse(placed);
    if (!parsed.success) return { error: describeIssue(parsed.error) };
    const laidOut = nodes.some((node) => !node.position) ? autoLayout(parsed.data) : parsed.data;
    const problem = graphProblem(laidOut);
    return problem ? { error: problem } : { definition: laidOut };
  }
  if (Array.isArray(input.steps)) {
    const parsed = legacySchema.safeParse(value);
    if (!parsed.success) return { error: describeIssue(parsed.error) };
    const converted = fromLegacy(parsed.data);
    const problem = graphProblem(converted);
    return problem ? { error: problem } : { definition: converted };
  }
  return { error: "Send either steps (a list, with then and else on If and body on For each item) or nodes and edges." };
}

function describeIssue(error: z.ZodError) {
  const issue = error.issues[0];
  return issue ? `The definition isn't valid at ${issue.path.join(".") || "the top"}: ${issue.message}` : "The definition isn't valid.";
}
