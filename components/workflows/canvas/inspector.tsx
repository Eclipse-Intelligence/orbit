"use client";

import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { GROUP_STYLE, STEP_META, TRIGGER_ICON } from "@/components/workflows/canvas/node-meta";
import StepConfig, { type BuilderOptions } from "@/components/workflows/step-config";
import TriggerEditor from "@/components/workflows/trigger-editor";
import { STEP_LABELS, TRIGGER_NODE, type WorkflowDefinition, type WorkflowNode } from "@/lib/workflows/definition";
import { variableOptions } from "@/lib/workflows/variables";
import { cn } from "@/lib/utils";

const OUTPUT_HINTS: Partial<Record<WorkflowNode["type"], string>> = {
  loop: "Steps on Each item run once per item. The run then carries on from Done.",
  approval: "Approve on the Workflows page. Rejecting stops the run.",
};

export default function Inspector({
  definition,
  selected,
  onChange,
  options,
  readOnly,
}: {
  definition: WorkflowDefinition;
  selected: string | null;
  onChange: (definition: WorkflowDefinition) => void;
  options: BuilderOptions;
  readOnly: boolean;
}) {
  if (!selected) {
    return (
      <div className="p-4">
        <p className="caption-style text-subtle leading-[1.45]">Select a step to edit it. Drag from a step&apos;s dot to connect it.</p>
      </div>
    );
  }

  if (selected === TRIGGER_NODE) {
    return (
      <div className={cn("flex flex-col gap-4 p-4", readOnly && "pointer-events-none opacity-80")}>
        <header className="flex items-center gap-2.5">
          <span className={cn("grid size-8 place-items-center rounded-lg", GROUP_STYLE.trigger)}>
            <TRIGGER_ICON aria-hidden className="size-3.5" />
          </span>
          <span className="text-[14px] leading-5 font-medium">Trigger</span>
        </header>
        <TriggerEditor trigger={definition.trigger} options={options} onChange={(trigger) => onChange({ ...definition, trigger })} />
      </div>
    );
  }

  const node = definition.nodes.find((item) => item.id === selected);
  if (!node) return null;
  const meta = STEP_META[node.type];
  const update = (next: WorkflowNode) => onChange({ ...definition, nodes: definition.nodes.map((item) => (item.id === node.id ? next : item)) });
  const remove = () =>
    onChange({
      ...definition,
      nodes: definition.nodes.filter((item) => item.id !== node.id),
      edges: definition.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id),
    });

  return (
    <div className={cn("flex flex-col gap-4 p-4", readOnly && "pointer-events-none opacity-80")}>
      <header className="flex items-center gap-2.5">
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", GROUP_STYLE[meta.group])}>
          <meta.icon aria-hidden className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 text-[14px] leading-5 font-medium">{STEP_LABELS[node.type]}</span>
        {!readOnly && (
          <Button variant="ghost" size="sm" className="text-danger" onClick={remove}>
            Delete
          </Button>
        )}
      </header>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${node.id}-label`} className="caption-style text-subtle">
          Name
        </label>
        <Input
          id={`${node.id}-label`}
          value={node.label ?? ""}
          placeholder={STEP_LABELS[node.type]}
          maxLength={120}
          onChange={(event) => update({ ...node, label: event.target.value || undefined })}
        />
      </div>
      <StepConfig step={node} update={(config) => update({ ...node, config })} variables={variableOptions(definition, node.id)} options={options} />
      {OUTPUT_HINTS[node.type] && <p className="caption-style text-subtle leading-[1.45]">{OUTPUT_HINTS[node.type]}</p>}
    </div>
  );
}
