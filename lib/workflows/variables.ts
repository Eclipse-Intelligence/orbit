import type { ConditionOp, WorkflowDefinition } from "@/lib/workflows/definition";
import { ancestors } from "@/lib/workflows/definition";

export type Vars = Record<string, unknown>;

export type Condition = { left: string; op: ConditionOp; right?: string };

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const SINGLE = /^\s*\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}\s*$/;

function lookup(vars: Vars, path: string): unknown {
  let current: unknown = vars;
  for (const part of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function display(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => `- ${typeof item === "object" && item !== null ? JSON.stringify(item) : display(item)}`).join("\n");
  }
  return JSON.stringify(value);
}

export function render(template: unknown, vars: Vars): string {
  if (typeof template !== "string") return "";
  return template.replace(TOKEN, (_, path: string) => display(lookup(vars, path)));
}

export function resolve(template: unknown, vars: Vars): unknown {
  if (typeof template !== "string") return template;
  const single = SINGLE.exec(template);
  return single ? lookup(vars, single[1]) : render(template, vars);
}

function empty(value: unknown) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function text(value: unknown) {
  return display(value).trim().toLowerCase();
}

export function check(condition: Condition, vars: Vars) {
  const left = resolve(condition.left, vars);
  const right = render(condition.right ?? "", vars).trim();
  switch (condition.op) {
    case "is_empty":
      return empty(left);
    case "is_not_empty":
      return !empty(left);
    case "is":
      return typeof left === "boolean" ? String(left) === right.toLowerCase() : text(left) === right.toLowerCase();
    case "is_not":
      return typeof left === "boolean" ? String(left) !== right.toLowerCase() : text(left) !== right.toLowerCase();
    case "contains":
      return Array.isArray(left) ? left.some((item) => text(item) === right.toLowerCase()) : text(left).includes(right.toLowerCase());
    case "not_contains":
      return Array.isArray(left) ? !left.some((item) => text(item) === right.toLowerCase()) : !text(left).includes(right.toLowerCase());
    case "greater_than":
      return Number(display(left)) > Number(right);
    case "less_than":
      return Number(display(left)) < Number(right);
    default:
      return false;
  }
}

export function conditionsPass(config: Record<string, unknown>, vars: Vars) {
  const conditions = Array.isArray(config.conditions) ? (config.conditions as Condition[]) : [];
  if (conditions.length === 0) return true;
  const results = conditions.map((condition) => check(condition, vars));
  return config.match === "any" ? results.some(Boolean) : results.every(Boolean);
}

export type VariableOption = { path: string; label: string; group: string };

const COMPANY: VariableOption[] = [
  { path: "company.name", label: "Name", group: "Company" },
  { path: "company.domain", label: "Domain", group: "Company" },
  { path: "company.lifecycle", label: "Lifecycle", group: "Company" },
  { path: "company.health", label: "Health", group: "Company" },
  { path: "company.healthReason", label: "Health reason", group: "Company" },
  { path: "company.industry", label: "Industry", group: "Company" },
  { path: "company.ownerName", label: "Owner", group: "Company" },
  { path: "company.website", label: "Website", group: "Company" },
  { path: "company.id", label: "Id", group: "Company" },
  { path: "company.url", label: "Link in Orbit", group: "Company" },
];

const CONTACT: VariableOption[] = [
  { path: "contact.name", label: "Name", group: "Contact" },
  { path: "contact.firstName", label: "First name", group: "Contact" },
  { path: "contact.email", label: "Email", group: "Contact" },
  { path: "contact.jobTitle", label: "Job title", group: "Contact" },
  { path: "contact.companyName", label: "Company name", group: "Contact" },
  { path: "contact.linkedinUrl", label: "LinkedIn", group: "Contact" },
  { path: "contact.id", label: "Id", group: "Contact" },
  { path: "contact.url", label: "Link in Orbit", group: "Contact" },
];

const BASE: VariableOption[] = [
  { path: "trigger.at", label: "When it ran", group: "Run" },
  { path: "owner.name", label: "Your name", group: "Run" },
  { path: "today", label: "Today's date", group: "Run" },
];

export function variableOptions(definition: WorkflowDefinition | null, nodeId?: string): VariableOption[] {
  const options = [...BASE];
  const type = definition?.trigger.type;
  const findsRecords = Boolean(definition?.nodes.some((node) => node.type === "find_records" || node.type === "upsert_record"));
  if (type && (type !== "schedule" || findsRecords)) options.push(...COMPANY, ...CONTACT);
  if (type === "email_received") {
    options.push(
      { path: "email.subject", label: "Subject", group: "Email" },
      { path: "email.fromName", label: "From", group: "Email" },
      { path: "email.from", label: "From address", group: "Email" },
      { path: "email.text", label: "Text", group: "Email" },
      { path: "email.kind", label: "Kind", group: "Email" },
      { path: "email.failedRecipient", label: "Address that bounced", group: "Email" },
      { path: "email.receivedAt", label: "Received", group: "Email" },
      { path: "email.url", label: "Link in Mail", group: "Email" },
    );
  }
  if (type === "call_summary_ready" || type === "activity_logged") {
    options.push(
      { path: "activity.type", label: "Type", group: "Activity" },
      { path: "activity.title", label: "Title", group: "Activity" },
      { path: "activity.body", label: "Notes", group: "Activity" },
    );
  }
  if (type === "call_summary_ready") {
    options.push(
      { path: "call.summary", label: "Summary", group: "Call" },
      { path: "call.sentiment", label: "Sentiment", group: "Call" },
      { path: "call.sentimentReason", label: "Sentiment reason", group: "Call" },
      { path: "call.keyPoints", label: "Key points", group: "Call" },
      { path: "call.actionItems", label: "Action items", group: "Call" },
      { path: "call.transcript", label: "Transcript", group: "Call" },
    );
  }
  if (type === "stage_changed" || type === "added_to_board") {
    options.push(
      { path: "deal.name", label: "Name", group: "Deal or card" },
      { path: "deal.stage", label: "Stage", group: "Deal or card" },
      { path: "deal.previousStage", label: "Previous stage", group: "Deal or card" },
      { path: "deal.board", label: "Board", group: "Deal or card" },
      { path: "deal.value", label: "Value", group: "Deal or card" },
    );
  }
  if (type === "field_changed") {
    options.push(
      { path: "change.field", label: "Field", group: "Change" },
      { path: "change.from", label: "Old value", group: "Change" },
      { path: "change.to", label: "New value", group: "Change" },
    );
  }
  if (type === "task_completed") {
    options.push({ path: "task.title", label: "Title", group: "Task" }, { path: "task.completedAt", label: "Completed", group: "Task" });
  }
  const upstream = definition && nodeId ? ancestors(definition, nodeId) : null;
  for (const step of (definition?.nodes ?? []).filter((node) => !upstream || upstream.has(node.id))) {
    const group = step.label || step.id;
    if (step.type === "ai") {
      const outputs = Array.isArray(step.config.outputs) ? (step.config.outputs as { key?: string }[]) : [];
      for (const output of outputs) {
        if (output.key) options.push({ path: `steps.${step.id}.${output.key}`, label: output.key, group });
      }
      if (step.config.webSearch === true && !outputs.some((output) => output.key === "sources")) {
        options.push({ path: `steps.${step.id}.sources`, label: "sources", group });
      }
    }
    if (step.type === "find_records") {
      options.push({ path: `steps.${step.id}.records`, label: "Records found", group }, { path: `steps.${step.id}.count`, label: "How many", group });
    }
    if (step.type === "upsert_record") {
      options.push(
        { path: `steps.${step.id}.id`, label: "Id", group },
        { path: `steps.${step.id}.name`, label: "Name", group },
        { path: `steps.${step.id}.created`, label: "Was created", group },
        { path: `steps.${step.id}.found`, label: "Was found", group },
        { path: `steps.${step.id}.url`, label: "Link in Orbit", group },
      );
    }
    if (step.type === "webhook") {
      options.push({ path: `steps.${step.id}.status`, label: "Status", group }, { path: `steps.${step.id}.response`, label: "Response", group });
    }
    if (step.type === "loop") {
      options.push({ path: "loop.item", label: "Current item", group }, { path: "loop.index", label: "Item number", group });
    }
    if (step.type === "create_task") options.push({ path: `steps.${step.id}.title`, label: "Task title", group });
    if (step.type === "linear_issue") {
      options.push({ path: `steps.${step.id}.identifier`, label: "Issue", group }, { path: `steps.${step.id}.url`, label: "Issue link", group });
    }
    if (step.type === "approval") options.push({ path: `steps.${step.id}.note`, label: "Approval note", group });
  }
  return options;
}
