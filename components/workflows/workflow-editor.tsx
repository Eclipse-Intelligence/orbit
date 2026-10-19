"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Button from "@/components/_ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import Switch from "@/components/_ui/switch";
import Tag from "@/components/_ui/tag";
import { recordSelectClass } from "@/components/crm/record-form";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import RunHistory from "@/components/workflows/run-history";
import type { BuilderOptions } from "@/components/workflows/step-config";
import StepList from "@/components/workflows/step-list";
import { textareaClass } from "@/components/workflows/template-field";
import TriggerEditor from "@/components/workflows/trigger-editor";
import {
  archiveWorkflowAction,
  createWorkflowAction,
  runWorkflowAction,
  saveWorkflowAction,
  setWorkflowStatusAction,
  setWorkflowTemplateAction,
} from "@/app/(crm)/workflows/actions";
import type { WorkflowDefinition } from "@/lib/workflows/definition";
import type { RunSummary, Workflow } from "@/lib/workflows/store";
import { cn } from "@/lib/utils";

type Records = { companies: { id: string; name: string }[]; contacts: { id: string; name: string }[] };

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
  const [description, setDescription] = useState(workflow.description ?? "");
  const [definition, setDefinition] = useState<WorkflowDefinition>(workflow.definition);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(initialRun ?? runs[0]?.id ?? null);
  const [testOpen, setTestOpen] = useState(false);
  const [testKind, setTestKind] = useState<"company" | "contact">("company");
  const [testId, setTestId] = useState("");

  function change(next: WorkflowDefinition) {
    setDefinition(next);
    setDirty(true);
    setMessage(null);
  }

  async function save() {
    setBusy("save");
    setError(null);
    const result = await saveWorkflowAction(workflow.id, { name, description: description || null, definition });
    setBusy(null);
    if (result.error) {
      setError(result.error);
      return false;
    }
    setDirty(false);
    setMessage("Saved.");
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
    if (result.runId) setSelectedRun(result.runId);
    router.refresh();
  }

  async function remove() {
    if (!window.confirm(`Delete ${workflow.name}? It stops running straight away.`)) return;
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
                className="focus-visible:ring-ring/60 min-w-0 rounded-sm bg-transparent text-[18px] leading-6 font-medium outline-none focus-visible:ring-2"
              />
            ) : (
              <h1 className="truncate">{workflow.name}</h1>
            )}
          </div>
        }
        action={
          editable ? (
            <div className="flex flex-wrap items-center gap-2">
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
                        <select aria-label="Record type" value={testKind} onChange={(event) => { setTestKind(event.target.value as "company" | "contact"); setTestId(""); }} className={recordSelectClass}>
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
            </div>
          ) : (
            <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => void copy()}>
              {busy === "copy" ? "Copying…" : "Use template"}
            </Button>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto grid w-full max-w-[80em] gap-6 px-4 py-6 pb-24 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
          <div className={cn("flex min-w-0 flex-col gap-5", !editable && "pointer-events-none opacity-80")} aria-disabled={!editable || undefined}>
            {!editable && (
              <p className="caption-style text-subtle pointer-events-auto">
                Shared by {workflow.ownerName ?? "a teammate"}. Use template to make your own copy you can edit and turn on.
              </p>
            )}
            {error && (
              <p role="alert" className="caption-style text-danger">
                {error}
              </p>
            )}
            {message && !error && (
              <p role="status" className="caption-style text-subtle">
                {message}
              </p>
            )}
            <textarea
              aria-label="Description"
              rows={2}
              value={description}
              placeholder="What this workflow is for (optional)"
              onChange={(event) => {
                setDescription(event.target.value);
                setDirty(true);
              }}
              className={cn(textareaClass, "resize-y")}
            />
            <section aria-labelledby="trigger-heading" className="border-line-strong bg-card flex flex-col gap-3 rounded-xl border p-4">
              <h2 id="trigger-heading" className="text-[14px] leading-5 font-medium">
                Trigger
              </h2>
              <TriggerEditor trigger={definition.trigger} options={options} onChange={(trigger) => change({ ...definition, trigger })} />
            </section>
            <section aria-labelledby="steps-heading" className="flex flex-col gap-3">
              <h2 id="steps-heading" className="text-[14px] leading-5 font-medium">
                Steps
              </h2>
              <StepList
                steps={definition.steps}
                root={definition.steps}
                trigger={definition.trigger}
                options={options}
                onChange={(steps) => change({ ...definition, steps })}
              />
            </section>
            {editable && (
              <section className="border-border flex flex-col gap-3 border-t pt-5">
                <label className="flex items-start justify-between gap-4">
                  <span className="flex flex-col gap-1">
                    <span className="text-[14px] leading-5">Share as a template</span>
                    <span className="caption-style text-subtle">Everyone in the workspace can copy it. Your runs and approvals stay private.</span>
                  </span>
                  <Switch checked={workflow.isTemplate} onChange={(on) => void share(on)} label="Share as a template" />
                </label>
                <Button variant="ghost" size="sm" className="text-danger self-start" disabled={busy !== null} onClick={() => void remove()}>
                  Delete workflow
                </Button>
              </section>
            )}
          </div>
          <aside aria-labelledby="runs-heading" className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 id="runs-heading" className="text-[14px] leading-5 font-medium">
                Runs
              </h2>
              {workflow.isTemplate && <Tag tone="blue">Shared</Tag>}
            </div>
            <RunHistory runs={runs} selected={selectedRun} onSelect={setSelectedRun} />
          </aside>
        </div>
      </div>
    </section>
  );
}
