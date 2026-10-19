"use client";

import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { GROUP_STYLE, STEP_META, TRIGGER_ICON } from "@/components/workflows/canvas/node-meta";
import StepConfig, { type BuilderOptions } from "@/components/workflows/step-config";
import TriggerEditor from "@/components/workflows/trigger-editor";
import { STEP_HINTS, STEP_LABELS, TRIGGER_NODE, type WorkflowDefinition, type WorkflowNode } from "@/lib/workflows/definition";
import { variableOptions } from "@/lib/workflows/variables";
import { cn } from "@/lib/utils";

const OUTPUT_HINTS: Partial<Record<WorkflowNode["type"], string>> = {
  if: "Connect Yes to what should happen when the condition is true, and No for when it isn't. Either can be left empty.",
  loop: "Connect Each item to the steps to repeat. They run once per item, then the run carries on from Done.",
  filter: "If the condition isn't true, this path stops here.",
  approval: "The run pauses until you approve on the Workflows page. Rejecting stops it.",
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
      <div className="flex flex-col gap-2 p-4">
        <h2 className="text-[14px] leading-5 font-medium">Nothing selected</h2>
        <p className="caption-style text-subtle leading-[1.45]">
          Click a node to edit it. Add nodes from the list, then drag from the dot under a node to the next node to connect them.
        </p>
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
          <span className="flex flex-col">
            <span className="text-[14px] leading-5 font-medium">Trigger</span>
            <span className="caption-style text-subtle">What starts this workflow</span>
          </span>
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
      <header className="flex items-start gap-2.5">
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", GROUP_STYLE[meta.group])}>
          <meta.icon aria-hidden className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[14px] leading-5 font-medium">{STEP_LABELS[node.type]}</span>
          <span className="caption-style text-subtle leading-[1.4]">{STEP_HINTS[node.type]}</span>
        </span>
        {!readOnly && (
          <Button variant="ghost" size="sm" className="text-danger" onClick={remove}>
            Delete
          </Button>
        )}
      </header>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${node.id}-label`} className="caption-style text-subtle">
          Name on the canvas
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
