"use client";

import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, type DragEvent } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { GROUP_STYLE, STEP_META, TRIGGER_ICON, nodeSummary, triggerSummary } from "@/components/workflows/canvas/node-meta";
import {
  HANDLE_LABELS,
  STEP_LABELS,
  TRIGGER_LABELS,
  TRIGGER_NODE,
  outputHandles,
  type StepType,
  type WorkflowDefinition,
  type WorkflowNode,
} from "@/lib/workflows/definition";
import { cn } from "@/lib/utils";

export type RunStatus = "succeeded" | "failed" | "waiting" | "skipped";

type CardData = {
  title: string;
  summary: string;
  kind: StepType | typeof TRIGGER_NODE;
  status: RunStatus | null;
};

type CardNode = Node<CardData, "card">;

export const DRAG_TYPE = "application/orbit-node";

const STATUS_RING: Record<RunStatus, string> = {
  succeeded: "ring-2 ring-success/70",
  failed: "ring-2 ring-danger/80",
  waiting: "ring-2 ring-warning/70",
  skipped: "",
};

const STATUS_TEXT: Record<RunStatus, string> = { succeeded: "Done", failed: "Failed", waiting: "Waiting", skipped: "" };

function Card({ data, selected }: NodeProps<CardNode>) {
  const trigger = data.kind === TRIGGER_NODE;
  const meta = trigger ? null : STEP_META[data.kind as StepType];
  const Icon = trigger ? TRIGGER_ICON : meta!.icon;
  const handles = outputHandles(data.kind);
  return (
    <div
      className={cn(
        "bg-card relative w-[220px] rounded-xl border px-3 py-2.5 shadow-[0_6px_20px_rgba(0,0,0,0.35)] transition-[border-color,box-shadow] duration-150",
        selected ? "border-primary ring-primary/40 ring-2" : "border-line-strong",
        !selected && data.status && STATUS_RING[data.status],
      )}
    >
      {!trigger && <Handle type="target" position={Position.Top} className="!bg-subtle !border-card !h-3 !w-3 !border-2" />}
      <div className="flex items-center gap-2.5">
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", GROUP_STYLE[trigger ? "trigger" : meta!.group])}>
          <Icon aria-hidden className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13.5px] leading-5 font-medium">{data.title}</span>
          <span className="caption-style text-subtle truncate">{data.summary}</span>
        </span>
      </div>
      {data.status && data.status !== "skipped" && (
        <span
          className={cn(
            "caption-style absolute -top-2.5 right-3 rounded-full px-1.5 leading-4",
            data.status === "succeeded" ? "bg-success/20 text-success" : data.status === "failed" ? "bg-danger/20 text-danger" : "bg-warning/20 text-warning",
          )}
        >
          {STATUS_TEXT[data.status]}
        </span>
      )}
      {handles.map((handle, index) => {
        const left = `${((index + 1) * 100) / (handles.length + 1)}%`;
        return (
          <div key={handle}>
            <Handle id={handle} type="source" position={Position.Bottom} style={{ left }} className="!bg-primary !border-card !h-3 !w-3 !border-2" />
            {handles.length > 1 && (
              <span
                className="caption-style text-subtle pointer-events-none absolute top-full mt-2 -translate-x-1/2 whitespace-nowrap"
                style={{ left }}
              >
                {HANDLE_LABELS[handle] ?? handle}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

const NODE_TYPES = { card: Card };

export default function WorkflowCanvas({
  definition,
  onChange,
  selected,
  onSelect,
  onDropNode,
  statuses,
  readOnly,
}: {
  definition: WorkflowDefinition;
  onChange: (definition: WorkflowDefinition) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onDropNode: (type: StepType, position: { x: number; y: number }) => void;
  statuses: Record<string, RunStatus> | null;
  readOnly: boolean;
}) {
  const flow = useReactFlow();
  const count = useRef(definition.nodes.length);

  useEffect(() => {
    if (definition.nodes.length > count.current) {
      const frame = window.requestAnimationFrame(() => void flow.fitView({ padding: 0.3, maxZoom: 1, duration: 300 }));
      count.current = definition.nodes.length;
      return () => window.cancelAnimationFrame(frame);
    }
    count.current = definition.nodes.length;
  }, [definition.nodes.length, flow]);

  const nodes = useMemo<CardNode[]>(
    () => [
      {
        id: TRIGGER_NODE,
        type: "card",
        position: definition.triggerPosition,
        deletable: false,
        selected: selected === TRIGGER_NODE,
        data: {
          title: "When",
          summary: definition.trigger.type === "manual" || definition.trigger.type === "record_created" || definition.trigger.type === "schedule"
            ? `${TRIGGER_LABELS[definition.trigger.type]} · ${triggerSummary(definition.trigger)}`
            : triggerSummary(definition.trigger),
          kind: TRIGGER_NODE,
          status: statuses ? "succeeded" : null,
        },
      },
      ...definition.nodes.map((node: WorkflowNode) => ({
        id: node.id,
        type: "card" as const,
        position: node.position,
        selected: selected === node.id,
        data: {
          title: node.label || STEP_LABELS[node.type],
          summary: nodeSummary(node),
          kind: node.type,
          status: statuses ? (statuses[node.id] ?? null) : null,
        },
      })),
    ],
    [definition, selected, statuses],
  );

  const edges = useMemo<Edge[]>(
    () =>
      definition.edges.map((edge) => ({
        id: `${edge.source}:${edge.handle}:${edge.target}`,
        source: edge.source,
        sourceHandle: edge.handle,
        target: edge.target,
        type: "smoothstep",
        animated: Boolean(statuses && statuses[edge.target] === "succeeded"),
        style: { strokeWidth: 1.75 },
      })),
    [definition.edges, statuses],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]) => {
      let next = definition;
      for (const change of changes) {
        if (change.type === "select") {
          if (change.selected) onSelect(change.id);
          else if (selected === change.id) onSelect(null);
        }
        if (readOnly) continue;
        if (change.type === "position" && change.position) {
          const position = change.position;
          next =
            change.id === TRIGGER_NODE
              ? { ...next, triggerPosition: position }
              : { ...next, nodes: next.nodes.map((node) => (node.id === change.id ? { ...node, position } : node)) };
        }
        if (change.type === "remove" && change.id !== TRIGGER_NODE) {
          next = {
            ...next,
            nodes: next.nodes.filter((node) => node.id !== change.id),
            edges: next.edges.filter((edge) => edge.source !== change.id && edge.target !== change.id),
          };
          if (selected === change.id) onSelect(null);
        }
      }
      if (next !== definition) onChange(next);
    },
    [definition, onChange, onSelect, readOnly, selected],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (readOnly) return;
      const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
      if (removed.size === 0) return;
      onChange({ ...definition, edges: definition.edges.filter((edge) => !removed.has(`${edge.source}:${edge.handle}:${edge.target}`)) });
    },
    [definition, onChange, readOnly],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (readOnly || !connection.source || !connection.target || connection.source === connection.target) return;
      const handle = connection.sourceHandle ?? "out";
      onChange({
        ...definition,
        edges: [
          ...definition.edges.filter((edge) => !(edge.source === connection.source && edge.handle === handle)),
          { source: connection.source, handle, target: connection.target },
        ],
      });
    },
    [definition, onChange, readOnly],
  );

  function onDragOver(event: DragEvent) {
    if (readOnly || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function onDrop(event: DragEvent) {
    if (readOnly) return;
    const type = event.dataTransfer?.getData(DRAG_TYPE) as StepType | undefined;
    if (!type) return;
    event.preventDefault();
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    onDropNode(type, { x: point.x - 110, y: point.y - 28 });
  }

  return (
    <ReactFlow<CardNode>
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onPaneClick={() => onSelect(null)}
      onDragOver={onDragOver}
      onDrop={onDrop}
      colorMode="dark"
      fitView
      fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
      minZoom={0.3}
      maxZoom={1.5}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
      proOptions={{ hideAttribution: true }}
      className="!bg-background"
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="rgba(255,255,255,0.08)" />
      <Controls showInteractive={false} position="top-left" />
    </ReactFlow>
  );
}
