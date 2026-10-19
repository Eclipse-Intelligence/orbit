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

export type Step = {
  id: string;
  type: StepType;
  label?: string;
  config: Record<string, unknown>;
  then?: Step[];
  else?: Step[];
  body?: Step[];
};

const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    type: z.enum(STEP_TYPES),
    label: z.string().max(120).optional(),
    config: z.record(z.string(), z.unknown()),
    then: z.array(stepSchema).max(50).optional(),
    else: z.array(stepSchema).max(50).optional(),
    body: z.array(stepSchema).max(50).optional(),
  }),
);

export const definitionSchema = z.object({
  trigger: triggerSchema,
  steps: z.array(stepSchema).max(50),
});
export type WorkflowDefinition = z.infer<typeof definitionSchema>;

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
  if: "If / else",
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
  if: "Run different steps depending on a condition.",
  filter: "Stop the run unless a condition is true.",
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

export function parseDefinition(value: unknown): WorkflowDefinition {
  return definitionSchema.parse(value);
}

export function safeDefinition(value: unknown): WorkflowDefinition | null {
  const parsed = definitionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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
  const base = type === "ai" ? "ai" : type;
  for (let index = 1; index < 500; index += 1) {
    const id = `${base}_${index}`;
    if (!existing.includes(id)) return id;
  }
  return `${base}_${Date.now()}`;
}

export function allSteps(steps: Step[]): Step[] {
  return steps.flatMap((step) => [step, ...allSteps(step.then ?? []), ...allSteps(step.else ?? []), ...allSteps(step.body ?? [])]);
}
