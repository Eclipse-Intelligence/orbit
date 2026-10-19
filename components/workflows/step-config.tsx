"use client";

import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Input } from "@/components/_ui/input";
import { recordSelectClass } from "@/components/crm/record-form";
import TemplateField from "@/components/workflows/template-field";
import {
  AI_MODELS,
  AI_OUTPUT_TYPES,
  CONDITION_OPS,
  FIELD_OPTIONS,
  type Step,
} from "@/lib/workflows/definition";
import type { Condition, VariableOption } from "@/lib/workflows/variables";
import { cn } from "@/lib/utils";

export type BuilderOptions = {
  boards: { id: string; name: string; stages: { id: string; name: string }[] }[];
  salesStages: { id: string; name: string }[];
  members: { id: string; name: string }[];
  lifecycles: { value: string; label: string }[];
};

export function matchLifecycleOption(options: BuilderOptions["lifecycles"], value: string) {
  const lower = value.trim().toLowerCase();
  return options.find((option) => option.value.toLowerCase() === lower || option.label.toLowerCase() === lower)?.value ?? "";
}

type Output = { key: string; type: string; description?: string; choices?: string[] };

const OP_LABELS: Record<string, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "doesn't contain",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  greater_than: "is more than",
  less_than: "is less than",
};

const TYPE_LABELS: Record<string, string> = { text: "Text", number: "Number", boolean: "Yes or no", list: "List", choice: "One of" };

function Select({
  id,
  label,
  value,
  onChange,
  children,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="caption-style text-subtle">
        {label}
      </label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className={recordSelectClass}>
        {children}
      </select>
    </div>
  );
}

function str(value: unknown) {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function PersonSelect({ id, label, value, onChange, options }: { id: string; label: string; value: string; onChange: (value: string) => void; options: BuilderOptions }) {
  return (
    <Select id={id} label={label} value={value || "owner"} onChange={onChange}>
      <option value="owner">Me</option>
      <option value="record_owner">The company or contact owner</option>
      {options.members.map((member) => (
        <option key={member.id} value={member.id}>
          {member.name}
        </option>
      ))}
    </Select>
  );
}

function Conditions({ step, update, variables }: { step: Step; update: (config: Record<string, unknown>) => void; variables: VariableOption[] }) {
  const conditions = (Array.isArray(step.config.conditions) ? step.config.conditions : []) as Condition[];
  const set = (next: Condition[]) => update({ ...step.config, conditions: next });
  return (
    <div className="flex flex-col gap-3">
      {conditions.length > 1 && (
        <Select id={`${step.id}-match`} label="Match" value={str(step.config.match) || "all"} onChange={(value) => update({ ...step.config, match: value })} className="sm:w-56">
          <option value="all">All of these</option>
          <option value="any">Any of these</option>
        </Select>
      )}
      {conditions.map((condition, index) => (
        <div key={index} className="border-border flex flex-col gap-2 rounded-lg border p-3">
          <Select
            id={`${step.id}-left-${index}`}
            label="When"
            value={condition.left}
            onChange={(value) => set(conditions.map((item, at) => (at === index ? { ...item, left: value } : item)))}
          >
            <option value="">Choose a field…</option>
            {condition.left && !variables.some((option) => `{{${option.path}}}` === condition.left) && (
              <option value={condition.left}>{condition.left}</option>
            )}
            {[...new Set(variables.map((option) => option.group))].map((group) => (
              <optgroup key={group} label={group}>
                {variables
                  .filter((option) => option.group === group)
                  .map((option) => (
                    <option key={option.path} value={`{{${option.path}}}`}>
                      {option.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </Select>
          <div className="flex flex-col gap-2">
            <Select
              id={`${step.id}-op-${index}`}
              label="Check"
              value={condition.op}
              onChange={(value) => set(conditions.map((item, at) => (at === index ? { ...item, op: value as Condition["op"] } : item)))}
            >
              {CONDITION_OPS.map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </Select>
            {condition.op !== "is_empty" && condition.op !== "is_not_empty" && (
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <label htmlFor={`${step.id}-right-${index}`} className="caption-style text-subtle">
                  Compared with
                </label>
                <Input
                  id={`${step.id}-right-${index}`}
                  value={condition.right ?? ""}
                  onChange={(event) => set(conditions.map((item, at) => (at === index ? { ...item, right: event.target.value } : item)))}
                />
              </div>
            )}
            {conditions.length > 1 && (
              <Button variant="ghost" size="sm" className="self-start" onClick={() => set(conditions.filter((_, at) => at !== index))}>
                Remove
              </Button>
            )}
          </div>
        </div>
      ))}
      <Button variant="ghost" size="sm" className="self-start" onClick={() => set([...conditions, { left: "", op: "is", right: "" }])}>
        Add condition
      </Button>
    </div>
  );
}

function Outputs({ step, update }: { step: Step; update: (config: Record<string, unknown>) => void }) {
  const outputs = (Array.isArray(step.config.outputs) ? step.config.outputs : []) as Output[];
  const set = (next: Output[]) => update({ ...step.config, outputs: next });
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="caption-style text-subtle pb-1.5">Answers (later nodes can use these)</legend>
      {outputs.map((output, index) => (
        <div key={index} className="border-border flex flex-col gap-2 rounded-lg border p-3">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <Input
              aria-label="Field name"
              placeholder="field_name"
              value={output.key}
              onChange={(event) =>
                set(outputs.map((item, at) => (at === index ? { ...item, key: event.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 40) } : item)))
              }
            />
            <select
              aria-label="Type"
              value={output.type}
              onChange={(event) => set(outputs.map((item, at) => (at === index ? { ...item, type: event.target.value } : item)))}
              className={cn(recordSelectClass, "w-32")}
            >
              {AI_OUTPUT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABELS[type]}
                </option>
              ))}
            </select>
            <Input
              aria-label="What it should contain"
              placeholder="What it should contain"
              value={output.description ?? ""}
              onChange={(event) => set(outputs.map((item, at) => (at === index ? { ...item, description: event.target.value } : item)))}
              className="col-span-2"
            />
          </div>
          {outputs.length > 1 && (
            <Button variant="ghost" size="sm" className="self-start" onClick={() => set(outputs.filter((_, at) => at !== index))}>
              Remove
            </Button>
          )}
          {output.type === "choice" && (
            <Input
              aria-label="Choices, separated by commas"
              placeholder="Choices, separated by commas"
              value={(output.choices ?? []).join(", ")}
              onChange={(event) =>
                set(outputs.map((item, at) => (at === index ? { ...item, choices: event.target.value.split(",").map((choice) => choice.trimStart()) } : item)))
              }
            />
          )}
        </div>
      ))}
      <Button variant="ghost" size="sm" className="self-start" onClick={() => set([...outputs, { key: "", type: "text", description: "" }])}>
        Add answer
      </Button>
    </fieldset>
  );
}

export default function StepConfig({
  step,
  update,
  variables,
  options,
}: {
  step: Step;
  update: (config: Record<string, unknown>) => void;
  variables: VariableOption[];
  options: BuilderOptions;
}) {
  const c = step.config;
  const field = (key: string, label: string, extra: { rows?: number; placeholder?: string; hint?: string } = {}) => (
    <TemplateField
      id={`${step.id}-${key}`}
      label={label}
      value={str(c[key])}
      options={variables}
      onChange={(value) => update({ ...c, [key]: value })}
      {...extra}
    />
  );

  switch (step.type) {
    case "ai":
      return (
        <div className="flex flex-col gap-3">
          <Select id={`${step.id}-model`} label="Model" value={str(c.model) || AI_MODELS[0].id} onChange={(value) => update({ ...c, model: value })} className="sm:w-72">
            {AI_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </Select>
          {field("prompt", "Prompt", { rows: 8, placeholder: "Review this call with {{company.name}} and…" })}
          <Outputs step={step} update={update} />
        </div>
      );
    case "if":
    case "filter":
      return <Conditions step={step} update={update} variables={variables} />;
    case "loop":
      return (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">{field("items", "List to go through", { placeholder: "{{steps.ai_1.productRequests}}" })}</div>
          <div className="flex flex-col gap-1.5 sm:w-32">
            <label htmlFor={`${step.id}-limit`} className="caption-style text-subtle">
              At most
            </label>
            <Input id={`${step.id}-limit`} type="number" min={1} max={100} value={str(c.limit) || "25"} onChange={(event) => update({ ...c, limit: Number(event.target.value) })} />
          </div>
        </div>
      );
    case "delay":
      return (
        <div className="flex gap-2">
          <div className="flex w-28 flex-col gap-1.5">
            <label htmlFor={`${step.id}-amount`} className="caption-style text-subtle">
              Wait
            </label>
            <Input id={`${step.id}-amount`} type="number" min={1} value={str(c.amount) || "1"} onChange={(event) => update({ ...c, amount: Number(event.target.value) })} />
          </div>
          <Select id={`${step.id}-unit`} label="Unit" value={str(c.unit) || "hours"} onChange={(value) => update({ ...c, unit: value })} className="w-36">
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
          </Select>
        </div>
      );
    case "approval":
      return (
        <div className="flex flex-col gap-3">
          {field("title", "What to approve", { placeholder: "Create Linear issues for {{company.name}}?" })}
          {field("details", "Details to show", { rows: 4 })}
        </div>
      );
    case "create_task":
      return (
        <div className="flex flex-col gap-3">
          {field("title", "Task")}
          {field("notes", "Notes", { rows: 3 })}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${step.id}-due`} className="caption-style text-subtle">
                Due in (days)
              </label>
              <Input id={`${step.id}-due`} type="number" min={0} value={str(c.dueInDays)} placeholder="No due date" onChange={(event) => update({ ...c, dueInDays: event.target.value })} />
            </div>
            <PersonSelect id={`${step.id}-assignee`} label="Assign to" value={str(c.assignee)} onChange={(value) => update({ ...c, assignee: value })} options={options} />
            <Select id={`${step.id}-link`} label="Link to" value={str(c.link) || "company"} onChange={(value) => update({ ...c, link: value })}>
              <option value="company">The company</option>
              <option value="contact">The contact</option>
              <option value="none">Nothing</option>
            </Select>
          </div>
          <label className="caption-style text-subtle flex items-center gap-2">
            <Checkbox checked={c.clickup === true} onCheckedChange={(value) => update({ ...c, clickup: value === true })} />
            Also create it in ClickUp
          </label>
        </div>
      );
    case "add_note":
      return (
        <div className="flex flex-col gap-3">
          {field("title", "Title")}
          {field("body", "Note", { rows: 5 })}
        </div>
      );
    case "update_record": {
      const object = str(c.object) === "contact" ? "contact" : "company";
      const fields = FIELD_OPTIONS[object];
      return (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select id={`${step.id}-object`} label="Record" value={object} onChange={(value) => update({ ...c, object: value, field: FIELD_OPTIONS[value as "company"][0].key })}>
              <option value="company">Company</option>
              <option value="contact">Contact</option>
            </Select>
            <Select id={`${step.id}-field`} label="Field" value={str(c.field) || fields[0].key} onChange={(value) => update({ ...c, field: value })}>
              {fields.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </Select>
          </div>
          {(str(c.field) || fields[0].key) === "lifecycle" ? (
            <Select
              id={`${step.id}-value`}
              label="New value"
              value={matchLifecycleOption(options.lifecycles, str(c.value) || "customer")}
              onChange={(value) => update({ ...c, value })}
            >
              {options.lifecycles.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          ) : (str(c.field) || fields[0].key) === "health" ? (
            <Select id={`${step.id}-value`} label="New value" value={str(c.value) || "at_risk"} onChange={(value) => update({ ...c, value })}>
              <option value="healthy">Healthy</option>
              <option value="watch">Watch</option>
              <option value="at_risk">At risk</option>
            </Select>
          ) : (str(c.field) || fields[0].key) === "ownerId" ? (
            <Select id={`${step.id}-value`} label="New owner" value={str(c.value) || "owner"} onChange={(value) => update({ ...c, value })}>
              <option value="owner">Me</option>
              {options.members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </Select>
          ) : (
            field("value", "New value")
          )}
        </div>
      );
    }
    case "board": {
      const board = options.boards.find((item) => item.id === str(c.boardId));
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select id={`${step.id}-board`} label="Board" value={str(c.boardId)} onChange={(value) => update({ ...c, boardId: value, stageId: "" })}>
            <option value="">Choose a board</option>
            {options.boards.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
          <Select id={`${step.id}-stage`} label="Stage" value={str(c.stageId)} onChange={(value) => update({ ...c, stageId: value })}>
            <option value="">First stage (or leave where it is)</option>
            {(board?.stages ?? []).map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </Select>
        </div>
      );
    }
    case "notify":
      return (
        <div className="flex flex-col gap-3">
          <PersonSelect id={`${step.id}-to`} label="Notify" value={str(c.to)} onChange={(value) => update({ ...c, to: value })} options={options} />
          {field("title", "Title")}
          {field("body", "Message", { rows: 3 })}
        </div>
      );
    case "send_email":
      return (
        <div className="flex flex-col gap-3">
          <p className="caption-style text-subtle">Sends to the run&apos;s contact from your Outlook, and logs it on their timeline.</p>
          {field("subject", "Subject")}
          {field("body", "Email", { rows: 6 })}
        </div>
      );
    case "linear_issue":
      return (
        <div className="flex flex-col gap-3">
          {field("title", "Issue title")}
          {field("description", "Description", { rows: 5 })}
          <Select id={`${step.id}-priority`} label="Priority" value={str(c.priority) || "medium"} onChange={(value) => update({ ...c, priority: value })} className="sm:w-48">
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </Select>
        </div>
      );
    default:
      return null;
  }
}
