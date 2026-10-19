import type { ComponentType, SVGProps } from "react";
import { AI_MODELS, STEP_LABELS, TRIGGER_LABELS, type StepType, type Trigger, type WorkflowNode } from "@/lib/workflows/definition";
import type { Condition } from "@/lib/workflows/variables";
import SparkleIcon from "@/public/assets/images/assistant/sparkle.svg";
import CheckIcon from "@/public/assets/images/booking/check.svg";
import ClockIcon from "@/public/assets/images/booking/clock.svg";
import FilterIcon from "@/public/assets/images/_common/filter.svg";
import BellIcon from "@/public/assets/images/companies/header/bell.svg";
import ColumnsIcon from "@/public/assets/images/companies/sidebar/columns.svg";
import ZapIcon from "@/public/assets/images/companies/sidebar/zap.svg";
import CheckSquareIcon from "@/public/assets/images/companies/table/check-square.svg";
import EmailIcon from "@/public/assets/images/crm/activity/email.svg";
import NoteIcon from "@/public/assets/images/crm/activity/note.svg";
import BranchIcon from "@/public/assets/images/workflows/branch.svg";
import EditIcon from "@/public/assets/images/workflows/edit.svg";
import LinearIcon from "@/public/assets/images/workflows/linear.svg";
import RepeatIcon from "@/public/assets/images/workflows/repeat.svg";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

export type NodeGroup = "trigger" | "ai" | "logic" | "action";

export const GROUP_STYLE: Record<NodeGroup, string> = {
  trigger: "bg-[var(--tag-amber-bg)] text-[var(--tag-amber-text)]",
  ai: "bg-[var(--tag-purple-bg)] text-[var(--tag-purple-text)]",
  logic: "bg-[var(--tag-blue-bg)] text-[var(--tag-blue-text)]",
  action: "bg-[var(--tag-green-bg)] text-[var(--tag-green-text)]",
};

export const STEP_META: Record<StepType, { icon: Icon; group: NodeGroup }> = {
  ai: { icon: SparkleIcon, group: "ai" },
  if: { icon: BranchIcon, group: "logic" },
  filter: { icon: FilterIcon, group: "logic" },
  loop: { icon: RepeatIcon, group: "logic" },
  delay: { icon: ClockIcon, group: "logic" },
  approval: { icon: CheckIcon, group: "logic" },
  create_task: { icon: CheckSquareIcon, group: "action" },
  add_note: { icon: NoteIcon, group: "action" },
  update_record: { icon: EditIcon, group: "action" },
  board: { icon: ColumnsIcon, group: "action" },
  notify: { icon: BellIcon, group: "action" },
  send_email: { icon: EmailIcon, group: "action" },
  linear_issue: { icon: LinearIcon, group: "action" },
};

export const TRIGGER_ICON = ZapIcon;

export const PALETTE: { label: string; types: StepType[] }[] = [
  { label: "AI", types: ["ai"] },
  { label: "Logic", types: ["if", "filter", "loop", "delay", "approval"] },
  { label: "Actions", types: ["create_task", "add_note", "update_record", "board", "notify", "send_email", "linear_issue"] },
];

function text(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function short(value: string, max = 48) {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function plain(value: string) {
  return value.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, path: string) => {
    const parts = path.split(".");
    return parts[0] === "steps" || parts[0] === "loop" ? parts[parts.length - 1] : parts.join(" ");
  });
}

const OPS: Record<string, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "doesn't contain",
  is_empty: "is empty",
  is_not_empty: "isn't empty",
  greater_than: ">",
  less_than: "<",
};

export function triggerSummary(trigger: Trigger) {
  if (trigger.type === "schedule") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return trigger.frequency === "daily" ? `Every day at ${trigger.time}` : `${days[trigger.weekday ?? 1]}s at ${trigger.time}`;
  }
  if (trigger.type === "manual" || trigger.type === "record_created") return trigger.object === "company" ? "Companies" : "Contacts";
  return TRIGGER_LABELS[trigger.type];
}

export function nodeSummary(node: WorkflowNode) {
  const c = node.config;
  switch (node.type) {
    case "ai": {
      const model = AI_MODELS.find((item) => item.id === c.model)?.label.split(" (")[0] ?? "AI";
      const prompt = short(plain(text(c.prompt)), 40);
      return prompt ? `${model}: ${prompt}` : "Write a prompt";
    }
    case "if":
    case "filter": {
      const first = (Array.isArray(c.conditions) ? (c.conditions as Condition[]) : [])[0];
      if (!first?.left) return "Set a condition";
      const value = first.op === "is_empty" || first.op === "is_not_empty" ? "" : ` ${first.right ?? ""}`;
      return short(`${plain(first.left)} ${OPS[first.op] ?? first.op}${value}`);
    }
    case "loop":
      return text(c.items) ? `Each of ${plain(text(c.items))}` : "Choose a list";
    case "delay":
      return `${Number(c.amount) || 1} ${text(c.unit) || "hours"}`;
    case "approval":
      return short(plain(text(c.title))) || "Ask me first";
    case "create_task":
    case "linear_issue":
      return short(plain(text(c.title))) || "Set a title";
    case "add_note":
      return short(plain(text(c.title) || text(c.body))) || "Write the note";
    case "update_record":
      return text(c.field) ? `Set ${text(c.field)}` : "Choose a field";
    case "board":
      return text(c.boardId) ? "Add or move the card" : "Choose a board";
    case "notify":
      return short(plain(text(c.title))) || "Write a message";
    case "send_email":
      return short(plain(text(c.subject))) || "Write the email";
    default:
      return STEP_LABELS[node.type];
  }
}
