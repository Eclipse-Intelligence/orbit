"use client";

import { useState } from "react";
import Button from "@/components/_ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import { Input } from "@/components/_ui/input";
import StepConfig, { type BuilderOptions } from "@/components/workflows/step-config";
import {
  allSteps,
  newStepId,
  STEP_HINTS,
  STEP_LABELS,
  type Step,
  type StepType,
  type Trigger,
} from "@/lib/workflows/definition";
import { variableOptions } from "@/lib/workflows/variables";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import { cn } from "@/lib/utils";

const GROUPS: { label: string; types: StepType[] }[] = [
  { label: "AI", types: ["ai"] },
  { label: "Logic", types: ["if", "filter", "loop", "delay", "approval"] },
  { label: "Actions", types: ["create_task", "add_note", "update_record", "board", "notify", "send_email", "linear_issue"] },
];

function defaults(type: StepType): Record<string, unknown> {
  switch (type) {
    case "ai":
      return { model: "claude-haiku-5-5", prompt: "", outputs: [{ key: "answer", type: "text", description: "" }] };
    case "if":
    case "filter":
      return { match: "all", conditions: [{ left: "", op: "is", right: "" }] };
    case "loop":
      return { items: "", limit: 25 };
    case "delay":
      return { amount: 1, unit: "days" };
    case "approval":
      return { title: "", details: "" };
    case "create_task":
      return { title: "", notes: "", dueInDays: "2", assignee: "owner", link: "company", clickup: false };
    case "add_note":
      return { title: "", body: "" };
    case "update_record":
      return { object: "company", field: "lifecycle", value: "customer" };
    case "board":
      return { boardId: "", stageId: "" };
    case "notify":
      return { to: "owner", title: "", body: "" };
    case "send_email":
      return { subject: "", body: "" };
    case "linear_issue":
      return { title: "", description: "", priority: "medium" };
    default:
      return {};
  }
}

export function AddStep({ root, onAdd, label = "Add step" }: { root: Step[]; onAdd: (step: Step) => void; label?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="self-start">
          <PlusIcon aria-hidden className="size-3" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80">
        {GROUPS.map((group) => (
          <div key={group.label}>
            <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
            {group.types.map((type) => (
              <DropdownMenuItem
                key={type}
                onSelect={() => {
                  const id = newStepId(type, allSteps(root).map((step) => step.id));
                  onAdd({
                    id,
                    type,
                    config: defaults(type),
                    ...(type === "if" ? { then: [], else: [] } : {}),
                    ...(type === "loop" ? { body: [] } : {}),
                  });
                }}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-foreground">{STEP_LABELS[type]}</span>
                  <span className="text-subtle leading-[1.35] whitespace-normal">{STEP_HINTS[type]}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StepCard({
  step,
  index,
  count,
  root,
  trigger,
  options,
  onChange,
  onMove,
  onRemove,
}: {
  step: Step;
  index: number;
  count: number;
  root: Step[];
  trigger: Trigger;
  options: BuilderOptions;
  onChange: (step: Step) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(true);
  const variables = variableOptions(trigger, root, step.id);
  const title = step.label || STEP_LABELS[step.type];

  return (
    <li className="border-line-strong bg-card flex flex-col rounded-xl border">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
          onClick={() => setOpen((value) => !value)}
          className="focus-visible:ring-ring/60 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2"
        >
          <ChevronDownIcon aria-hidden className={cn("ease-power3-out text-subtle size-3 shrink-0 transition-transform duration-150", !open && "-rotate-90")} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[14px] leading-5">{title}</span>
            <span className="caption-style text-subtle truncate">
              {STEP_LABELS[step.type]} · <span className="font-mono">{step.id}</span>
            </span>
          </span>
        </button>
        <Button variant="ghost" size="icon-sm" aria-label={`Move ${title} up`} disabled={index === 0} onClick={() => onMove(-1)}>
          <ChevronDownIcon aria-hidden className="size-3 rotate-180" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Move ${title} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
          <ChevronDownIcon aria-hidden className="size-3" />
        </Button>
        <Button variant="ghost" size="sm" className="text-danger" onClick={onRemove}>
          Remove
        </Button>
      </div>
      {open && (
        <div className="border-border flex flex-col gap-4 border-t p-3">
          <div className="flex flex-col gap-1.5 sm:w-72">
            <label htmlFor={`${step.id}-label`} className="caption-style text-subtle">
              Step name
            </label>
            <Input
              id={`${step.id}-label`}
              value={step.label ?? ""}
              placeholder={STEP_LABELS[step.type]}
              maxLength={120}
              onChange={(event) => onChange({ ...step, label: event.target.value || undefined })}
            />
          </div>
          <StepConfig step={step} update={(config) => onChange({ ...step, config })} variables={variables} options={options} />
          {step.type === "if" && (
            <div className="grid gap-3 lg:grid-cols-2">
              {(["then", "else"] as const).map((branch) => (
                <div key={branch} className="border-border flex flex-col gap-2 rounded-lg border border-dashed p-2">
                  <span className="caption-style text-subtle px-1">{branch === "then" ? "If yes" : "Otherwise"}</span>
                  <StepList
                    steps={step[branch] ?? []}
                    root={root}
                    trigger={trigger}
                    options={options}
                    onChange={(steps) => onChange({ ...step, [branch]: steps })}
                  />
                </div>
              ))}
            </div>
          )}
          {step.type === "loop" && (
            <div className="border-border flex flex-col gap-2 rounded-lg border border-dashed p-2">
              <span className="caption-style text-subtle px-1">For each item</span>
              <StepList steps={step.body ?? []} root={root} trigger={trigger} options={options} onChange={(steps) => onChange({ ...step, body: steps })} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export default function StepList({
  steps,
  root,
  trigger,
  options,
  onChange,
}: {
  steps: Step[];
  root: Step[];
  trigger: Trigger;
  options: BuilderOptions;
  onChange: (steps: Step[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {steps.length > 0 && (
        <ol className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <StepCard
              key={step.id}
              step={step}
              index={index}
              count={steps.length}
              root={root}
              trigger={trigger}
              options={options}
              onChange={(next) => onChange(steps.map((item) => (item.id === step.id ? next : item)))}
              onMove={(direction) => {
                const next = steps.slice();
                const target = index + direction;
                [next[index], next[target]] = [next[target], next[index]];
                onChange(next);
              }}
              onRemove={() => onChange(steps.filter((item) => item.id !== step.id))}
            />
          ))}
        </ol>
      )}
      <AddStep root={root} onAdd={(step) => onChange([...steps, step])} />
    </div>
  );
}
