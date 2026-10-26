"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ReactFlowProvider } from "@xyflow/react";
import Button from "@/components/_ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { Sheet, SheetCloseButton, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/_ui/sheet";
import Switch from "@/components/_ui/switch";
import { recordSelectClass } from "@/components/crm/record-form";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import Inspector from "@/components/workflows/canvas/inspector";
import Palette from "@/components/workflows/canvas/palette";
import WorkflowCanvas, { type RunStatus } from "@/components/workflows/canvas/workflow-canvas";
import RunHistory from "@/components/workflows/run-history";
import type { BuilderOptions } from "@/components/workflows/step-config";
import {
  archiveWorkflowAction,
  createWorkflowAction,
  runWorkflowAction,
  saveWorkflowAction,
  setWorkflowStatusAction,
  setWorkflowTemplateAction,
} from "@/app/(crm)/workflows/actions";
import {
  newStepId,
  nextNode,
  outputHandles,
  TRIGGER_NODE,
  type StepType,
  type WorkflowDefinition,
} from "@/lib/workflows/definition";
import type { RunStepLog, RunSummary, Workflow } from "@/lib/workflows/store";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import ConfirmDialog from "@/components/_ui/confirm-dialog";

type Records = { companies: { id: string; name: string }[]; contacts: { id: string; name: string }[] };

const DEFAULTS: Record<StepType, Record<string, unknown>> = {
  ai: { model: "claude-haiku-5-5", prompt: "", outputs: [{ key: "answer", type: "text", description: "" }] },
  if: { match: "all", conditions: [{ left: "", op: "is", right: "" }] },
  filter: { match: "all", conditions: [{ left: "", op: "is", right: "" }] },
  loop: { items: "", limit: 25 },
  delay: { amount: 1, unit: "days" },
  approval: { title: "", details: "" },
  create_task: { title: "", notes: "", dueInDays: "2", assignee: "owner", link: "company", clickup: false },
  add_note: { title: "", body: "" },
  update_record: { object: "company", field: "lifecycle", value: "customer" },
  board: { boardId: "", stageId: "" },
  notify: { to: "owner", title: "", body: "" },
  send_email: { subject: "", body: "" },
  linear_issue: { title: "", description: "", priority: "medium" },
  find_records: { object: "contact", lifecycles: [], tag: "", owner: "", openOpportunity: "any", quietDays: "", search: "", order: "least_contacted", limit: 25, skipDays: "" },
  upsert_record: { object: "company", name: "", domain: "", website: "", create: true, useInRun: false },
  webhook: { url: "", body: "" },
  create_proposal: { templateId: "", currency: "GBP", products: "ai", productIds: [], guidance: "", title: "" },
};

function narrow() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}

function statusesFrom(steps: RunStepLog[] | null): Record<string, RunStatus> | null {
  if (!steps) return null;
  const map: Record<string, RunStatus> = {};
  for (const step of steps) {
    const status = step.status as RunStatus;
    if (map[step.stepId] === "failed") continue;
    map[step.stepId] = status;
  }
  return map;
}

export default function WorkflowEditor({
  viewer,
  workflow,
  runs,
  options,
  records,
  initialRun,
}: {
  viewer: Viewer;
  workflow: Workflow;
  runs: RunSummary[];
  options: BuilderOptions;
  records: Records;
  initialRun: string | null;
}) {
  const router = useRouter();
  const editable = workflow.mine;
  const [name, setName] = useState(workflow.name);
  const [definition, setDefinition] = useState<WorkflowDefinition>(workflow.definition);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"node" | "runs">(initialRun ? "runs" : "node");
  const [selectedRun, setSelectedRun] = useState<string | null>(initialRun);
  const [runSteps, setRunSteps] = useState<RunStepLog[] | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [testKind, setTestKind] = useState<"company" | "contact">("company");
  const [testId, setTestId] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const change = useCallback((next: WorkflowDefinition) => {
    setDefinition(next);
    setDirty(true);
    setError(null);
  }, []);

  const select = useCallback((id: string | null) => {
    setSelected(id);
    if (id) {
      setPanel("node");
      if (narrow()) setSheetOpen(true);
    }
  }, []);

  const showSteps = useCallback((steps: RunStepLog[] | null) => setRunSteps(steps), []);

  function freeHandle(source: string) {
    const type = source === TRIGGER_NODE ? TRIGGER_NODE : definition.nodes.find((node) => node.id === source)?.type;
    if (!type) return null;
    return outputHandles(type).find((handle) => !nextNode(definition, source, handle)) ?? null;
  }

  function positionOf(id: string) {
    return id === TRIGGER_NODE ? definition.triggerPosition : (definition.nodes.find((node) => node.id === id)?.position ?? { x: 0, y: 0 });
  }

  function clear(position: { x: number; y: number }) {
    let next = position;
    while (definition.nodes.some((node) => Math.abs(node.position.x - next.x) < 220 && Math.abs(node.position.y - next.y) < 100)) {
      next = { x: next.x + 280, y: next.y };
    }
    return next;
  }

  function addNode(type: StepType, dropped?: { x: number; y: number }) {
    if (!editable) return;
    const id = newStepId(type, definition.nodes.map((node) => node.id));
    const candidates = [selected, TRIGGER_NODE, ...[...definition.nodes].reverse().map((node) => node.id)].filter(Boolean) as string[];
    const from = dropped ? null : (candidates.find((candidate) => freeHandle(candidate)) ?? null);
    const handle = from ? freeHandle(from) : null;
    const origin = from ? positionOf(from) : null;
    const index = from && handle ? outputHandles(from === TRIGGER_NODE ? TRIGGER_NODE : definition.nodes.find((node) => node.id === from)!.type).indexOf(handle) : 0;
    const position = clear(dropped ?? (origin ? { x: origin.x + index * 280, y: origin.y + 140 } : { x: 0, y: 140 }));
    change({
      ...definition,
      nodes: [...definition.nodes, { id, type, config: structuredClone(DEFAULTS[type]), position }],
      edges: from && handle ? [...definition.edges, { source: from, handle, target: id }] : definition.edges,
    });
    setPaletteOpen(false);
    select(id);
  }

  async function save() {
    setBusy("save");
    setError(null);
    const result = await saveWorkflowAction(workflow.id, { name, definition });
    setBusy(null);
    if (result.error) {
      setError(result.error);
      return false;
    }
    setDirty(false);
    router.refresh();
    return true;
  }

  async function toggle(on: boolean) {
    if (dirty && !(await save())) return;
    setBusy("status");
    setError(null);
    const result = await setWorkflowStatusAction(workflow.id, on ? "active" : "paused");
    setBusy(null);
    if (result.error) setError(result.error);
    router.refresh();
  }

  async function share(on: boolean) {
    setBusy("share");
    const result = await setWorkflowTemplateAction(workflow.id, on);
    setBusy(null);
    if (result.error) setError(result.error);
    router.refresh();
  }

  async function test() {
    if (dirty && !(await save())) return;
    const needsRecord = definition.trigger.type !== "schedule";
    if (needsRecord && !testId) {
      setError("Choose a record to test with.");
      return;
    }
    setBusy("test");
    setError(null);
    const result = await runWorkflowAction(workflow.id, { test: true, record: needsRecord ? { type: testKind, id: testId } : null });
    setBusy(null);
    setTestOpen(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.runId) {
      setSelectedRun(result.runId);
      setPanel("runs");
      if (narrow()) setSheetOpen(true);
    }
    router.refresh();
  }

  async function remove() {
    setBusy("delete");
    const result = await archiveWorkflowAction(workflow.id);
    setBusy(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.push("/workflows");
  }

  async function copy() {
    setBusy("copy");
    const result = await createWorkflowAction({ template: workflow.id });
    setBusy(null);
    if (result.id) router.push(`/workflows/${result.id}`);
    else setError(result.error ?? "Couldn't copy the template.");
  }

  const recordChoices = testKind === "company" ? records.companies : records.contacts;
  const active = workflow.status === "active";
  const statuses = panel === "runs" && selectedRun ? statusesFrom(runSteps) : null;

  const sidePanel = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Panel" className="border-border flex shrink-0 gap-1 border-b p-2">
        {(["node", "runs"] as const).map((tab) => (
          <Button
            key={tab}
            role="tab"
            aria-selected={panel === tab}
            variant={panel === tab ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setPanel(tab)}
          >
            {tab === "node" ? "Node" : `Runs${runs.length ? ` (${runs.length})` : ""}`}
          </Button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {panel === "node" ? (
          <Inspector definition={definition} selected={selected} onChange={change} options={options} readOnly={!editable} />
        ) : (
          <div className="p-3">
            <RunHistory runs={runs} selected={selectedRun} onSelect={setSelectedRun} onSteps={showSteps} />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title={workflow.name}
        viewer={viewer}
        heading={
          <div className="flex min-w-0 flex-col">
            <Link href="/workflows" className="caption-style text-subtle hover:text-foreground">
              Workflows
            </Link>
            {editable ? (
              <input
                aria-label="Workflow name"
                value={name}
                maxLength={120}
                onChange={(event) => {
                  setName(event.target.value);
                  setDirty(true);
                }}
                className="focus-visible:ring-ring/60 w-[min(36ch,60vw)] min-w-0 rounded-sm bg-transparent text-[16px] leading-6 font-medium outline-none focus-visible:ring-2"
              />
            ) : (
              <h1 className="truncate">{workflow.name}</h1>
            )}
          </div>
        }
        action={
          editable ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" className="lg:hidden" onClick={() => setPaletteOpen(true)}>
                <PlusIcon aria-hidden className="size-3" />
                Add node
              </Button>
              <label className="caption-style text-subtle flex items-center gap-2">
                <Switch checked={active} onChange={(on) => void toggle(on)} label={active ? "Turn off" : "Turn on"} />
                {active ? "On" : "Off"}
              </label>
              <Popover open={testOpen} onOpenChange={setTestOpen}>
                <PopoverTrigger asChild>
                  <Button variant="secondary" size="sm" disabled={busy !== null}>
                    {busy === "test" ? "Testing…" : "Test run"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-[min(340px,calc(100vw-2rem))]">
                  <div className="flex flex-col gap-3 p-4">
                    <p className="caption-style text-subtle leading-[1.45]">
                      Runs the AI and logic for real, but only shows what actions would do. Nothing is changed or sent.
                    </p>
                    {definition.trigger.type !== "schedule" && (
                      <>
                        <select
                          aria-label="Record type"
                          value={testKind}
                          onChange={(event) => {
                            setTestKind(event.target.value as "company" | "contact");
                            setTestId("");
                          }}
                          className={recordSelectClass}
                        >
                          <option value="company">A company</option>
                          <option value="contact">A contact</option>
                        </select>
                        <select aria-label="Record" value={testId} onChange={(event) => setTestId(event.target.value)} className={recordSelectClass}>
                          <option value="">Choose…</option>
                          {recordChoices.map((record) => (
                            <option key={record.id} value={record.id}>
                              {record.name}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                    <Button variant="primary" size="sm" className="self-start" disabled={busy !== null} onClick={() => void test()}>
                      Run test
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
              <Button variant="primary" size="sm" disabled={!dirty || busy !== null} data-shortcut="save" title="Save (⌘S)" onClick={() => void save()}>
                {busy === "save" ? "Saving…" : dirty ? "Save" : "Saved"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" aria-label="More">
                    More
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuItem onSelect={() => void share(!workflow.isTemplate)}>
                    {workflow.isTemplate ? "Stop sharing as a template" : "Share as a template"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      setPanel("runs");
                      if (narrow()) setSheetOpen(true);
                    }}
                  >
                    Show runs
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-danger" onSelect={() => setConfirmDelete(true)}>
                    Delete workflow
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : (
            <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void copy()}>
              {busy === "copy" ? "Copying…" : "Use template"}
            </Button>
          )
        }
      />
      {error && (
        <p role="alert" className="caption-style text-danger border-border border-b px-4 py-2">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        {editable && (
          <aside aria-label="Add nodes" className="border-border hidden w-56 shrink-0 overflow-auto border-r p-3 lg:block">
            <Palette onAdd={(type) => addNode(type)} />
          </aside>
        )}
        <div className="relative min-h-0 min-w-0 flex-1">
          <ReactFlowProvider>
            <WorkflowCanvas
              definition={definition}
              onChange={change}
              selected={selected}
              onSelect={select}
              onDropNode={(type, position) => addNode(type, position)}
              statuses={statuses}
              readOnly={!editable}
            />
          </ReactFlowProvider>
          {statuses && (
            <div className="bg-card border-line-strong caption-style absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-1.5">
              Showing a run
              <button type="button" className="text-foreground underline underline-offset-2" onClick={() => setSelectedRun(null)}>
                Clear
              </button>
            </div>
          )}
        </div>
        <aside aria-label="Details" className={cn("border-border hidden w-[360px] shrink-0 flex-col border-l md:flex")}>
          {sidePanel}
        </aside>
      </div>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="flex flex-col md:hidden">
          <SheetHeader>
            <SheetTitle>{panel === "runs" ? "Runs" : "Node"}</SheetTitle>
            <SheetDescription className="sr-only">Settings for the selected node, or recent runs</SheetDescription>
            <SheetCloseButton />
          </SheetHeader>
          {sidePanel}
        </SheetContent>
      </Sheet>
      <Sheet open={paletteOpen} onOpenChange={setPaletteOpen}>
        <SheetContent side="left" className="lg:hidden">
          <SheetHeader>
            <SheetTitle>Add a node</SheetTitle>
            <SheetDescription className="sr-only">Choose a node to add after the selected one</SheetDescription>
            <SheetCloseButton />
          </SheetHeader>
          <div className="overflow-auto p-3">
            <Palette onAdd={(type) => addNode(type)} />
          </div>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${workflow.name}?`}
        description="It stops running straight away. Past runs stay in the history."
        confirmLabel="Delete workflow"
        onConfirm={() => void remove()}
      />
    </section>
  );
}
