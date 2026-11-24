"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import CopyButton from "@/components/_ui/copy-button";
import HoldButton from "@/components/_ui/hold-button";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import Switch from "@/components/_ui/switch";
import { SettingsCard } from "@/components/crm/settings-ui";
import { addHeldLeadsAction, linkMetaPageAction, saveMetaOutcomesAction, unlinkMetaPageAction, type MetaLeadActionState } from "@/app/(crm)/settings/actions";
import { formatWhen, formatWhenShort } from "@/lib/companies";
import type { MetaLeadSettingsView } from "@/lib/crm/meta-leads";
import type { MetaOutcomesView } from "@/lib/crm/meta-outcomes";
import { cn, GENERIC_ERROR } from "@/lib/utils";

function Status({ on, bad = false, children }: { on: boolean; bad?: boolean; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", bad ? "bg-danger" : on ? "bg-success" : "bg-faint")} />
      {children}
    </span>
  );
}

type Section = "pages" | "outcomes" | "held";

function sectionOf(kind: string): Section {
  if (kind === "dataset" || kind === "enabled" || kind === "pipeline") return "outcomes";
  if (kind.startsWith("held:") || kind.startsWith("link:")) return "held";
  return "pages";
}

function Message({ state }: { state: MetaLeadActionState }) {
  return (
    <>
      {state.error && (
        <p role="alert" className="caption-style text-danger">
          {state.error}
        </p>
      )}
      {state.message && (
        <p role="status" className="caption-style text-soft">
          {state.message}
        </p>
      )}
    </>
  );
}

function leadCount(count: number) {
  return count === 1 ? "1 lead" : `${count.toLocaleString("en-GB")} leads`;
}

export default function MetaLeadsSettings({ view, outcomes, canAdmin }: { view: MetaLeadSettingsView; outcomes: MetaOutcomesView; canAdmin: boolean }) {
  const router = useRouter();
  const [pageId, setPageId] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ section: Section; state: MetaLeadActionState } | null>(null);
  const [datasetId, setDatasetId] = useState(outcomes.datasetId);
  const input = useRef<HTMLInputElement>(null);

  async function run(kind: string, action: () => Promise<MetaLeadActionState>) {
    const section = sectionOf(kind);
    setPending(kind);
    setOutcome(null);
    const result = await action().catch((): MetaLeadActionState => ({ error: GENERIC_ERROR }));
    setPending(null);
    setOutcome({ section, state: result });
    if (!result.error) {
      if (kind === "add") {
        setPageId("");
        input.current?.focus();
      }
      router.refresh();
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pageId.trim()) return;
    void run("add", () => linkMetaPageAction(pageId));
  }

  function saveDataset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run("dataset", () => saveMetaOutcomesAction({ datasetId: datasetId.trim() }));
  }

  const ready = outcomes.tokenSet && Boolean(outcomes.datasetId);
  const sentLine = [
    "Token set",
    `${outcomes.sent.toLocaleString("en-GB")} sent`,
    outcomes.failed > 0 ? `${outcomes.failed.toLocaleString("en-GB")} failed` : null,
    outcomes.lastSentAt ? `Last ${formatWhenShort(outcomes.lastSentAt)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const messageFor = (section: Section) => (outcome?.section === section ? <Message state={outcome.state} /> : null);

  return (
    <SettingsCard
      id="meta-leads"
      title="Meta lead ads"
      description={
        <span className="flex flex-col gap-1.5">
          <span>Each Facebook or Instagram lead form submission becomes a contact.</span>
          {view.configured ? <Status on>Set up</Status> : <Status on={false}>{view.setupMessage}</Status>}
        </span>
      }
    >
      {canAdmin && (
        <div className="flex flex-col gap-1.5">
          <span className="caption-style text-subtle">Callback URL</span>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="ui-style text-soft min-w-0 flex-1 wrap-anywhere">{view.endpoint}</code>
            <CopyButton text={view.endpoint} className="self-start sm:self-auto" />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h4 className="text-foreground leading-5">Pages</h4>
        {view.pages.length === 0 ? (
          <p className="caption-style text-subtle">No Pages linked.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {view.pages.map((page) => (
              <li key={page.id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="ui-style text-foreground wrap-anywhere">{page.pageName ?? `Page ${page.pageId}`}</span>
                  <span className="caption-style text-subtle wrap-anywhere">
                    {[page.pageName ? page.pageId : null, page.leads === null ? null : leadCount(page.leads), page.lastRunAt ? `Checked ${formatWhen(page.lastRunAt)}` : "Not checked yet"]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {page.lastError && (
                    <span className="caption-style text-danger" role="alert">
                      {page.lastError}
                    </span>
                  )}
                </span>
                {canAdmin && (
                  <HoldButton className="self-start sm:self-auto" disabled={pending !== null} onConfirm={() => void run(`remove:${page.id}`, () => unlinkMetaPageAction(page.id))}>
                    Hold to remove<span className="sr-only"> {page.pageName ?? page.pageId}</span>
                  </HoldButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {canAdmin && view.pages.length > 0 && <p className="caption-style text-subtle">Leads from a removed Page are held for an owner.</p>}
      </div>

      {canAdmin ? (
        <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={add}>
          <label className="flex min-w-0 flex-1 flex-col gap-1.5" htmlFor="meta-page-id">
            <span className="caption-style text-subtle">Facebook Page ID</span>
            <Input
              ref={input}
              id="meta-page-id"
              inputMode="numeric"
              autoComplete="off"
              value={pageId}
              maxLength={40}
              onChange={(event) => setPageId(event.target.value)}
              placeholder="123456789012345"
            />
          </label>
          <Button variant="primary" size="sm" type="submit" className="self-start sm:self-auto" disabled={pending !== null || !pageId.trim()}>
            {pending === "add" ? "Adding…" : "Add"}
          </Button>
        </form>
      ) : (
        <p className="caption-style text-subtle">Only owners and admins can change Meta lead ads.</p>
      )}

      {messageFor("pages")}

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-foreground leading-5">Send outcomes to Meta</h4>
          <Switch
            className="hit"
            label="Send outcomes to Meta"
            checked={outcomes.enabled}
            disabled={!canAdmin || pending !== null || (!outcomes.enabled && !ready)}
            onChange={(enabled) => void run("enabled", () => saveMetaOutcomesAction({ enabled }))}
          />
        </div>
        {canAdmin ? (
          <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={saveDataset}>
            <label className="flex min-w-0 flex-1 flex-col gap-1.5" htmlFor="meta-dataset-id">
              <span className="caption-style text-subtle">Dataset ID</span>
              <Input
                id="meta-dataset-id"
                inputMode="numeric"
                autoComplete="off"
                value={datasetId}
                maxLength={40}
                onChange={(event) => setDatasetId(event.target.value)}
                placeholder="123456789012345"
              />
            </label>
            <Button variant="secondary" size="sm" type="submit" className="self-start sm:self-auto" disabled={pending !== null || datasetId.trim() === outcomes.datasetId}>
              {pending === "dataset" ? "Saving…" : "Save"}
            </Button>
          </form>
        ) : (
          outcomes.datasetId && (
            <div className="flex flex-col gap-1">
              <span className="caption-style text-subtle">Dataset ID</span>
              <span className="ui-style text-soft">{outcomes.datasetId}</span>
            </div>
          )
        )}
        {canAdmin && outcomes.pipelines.length > 0 && (
          <label className="flex flex-col gap-1.5" htmlFor="meta-outcomes-pipeline">
            <span className="caption-style text-subtle">Pipeline</span>
            <NativeSelect
              id="meta-outcomes-pipeline"
              value={outcomes.pipelineId ?? ""}
              disabled={pending !== null}
              onChange={(event) => void run("pipeline", () => saveMetaOutcomesAction({ pipelineId: event.target.value || null }))}
            >
              {!outcomes.pipelineId && <option value="">Choose a pipeline</option>}
              {outcomes.pipelines.map((pipeline) => (
                <option key={pipeline.id} value={pipeline.id}>
                  {pipeline.name}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
        {outcomes.tokenSet ? <Status on>{sentLine}</Status> : <Status on={false} bad>Add META_DATASET_TOKEN to the environment.</Status>}
        {canAdmin && outcomes.lastError && (
          <p role="alert" className="caption-style text-danger">
            {outcomes.lastError}
          </p>
        )}
        {messageFor("outcomes")}
      </div>

      {outcomes.stages.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-foreground leading-5">Stages</h4>
          <span className="caption-style text-subtle">Use these names in Events Manager. Renaming a stage changes the name sent.</span>
          <ol className="border-border divide-border flex flex-col divide-y overflow-hidden rounded-[10px] border">
            {outcomes.stages.map((stage, index) => (
              <li key={stage.name} className="ui-style grid grid-cols-[1.25rem_1fr] items-baseline gap-x-2.5 gap-y-0.5 px-3 py-2 sm:grid-cols-[1.25rem_9.5em_1fr]">
                <span className="text-faint tabular-nums">{index + 1}</span>
                <code className="text-foreground font-[family-name:inherit] font-medium wrap-anywhere">{stage.name}</code>
                <span className="text-subtle col-start-2 sm:col-start-auto">{stage.note}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {view.held.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-foreground leading-5">Held leads</h4>
          <ul className="flex flex-col gap-2">
            {view.held.map((page) => (
              <li key={page.pageId} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="caption-style text-soft wrap-anywhere">
                  {[
                    `Page ${page.pageId}`,
                    leadCount(page.leads),
                    page.lastAt ? `Last ${formatWhen(page.lastAt)}` : null,
                    page.linkedTo ? `Linked to ${page.linkedTo}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {page.linkedHere ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    className="self-start sm:self-auto"
                    disabled={pending !== null}
                    onClick={() => void run(`held:${page.pageId}`, () => addHeldLeadsAction(page.pageId))}
                  >
                    Add here<span className="sr-only"> leads from Page {page.pageId}</span>
                  </Button>
                ) : (
                  !page.linkedTo && (
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      className="self-start sm:self-auto"
                      disabled={pending !== null}
                      onClick={() => void run(`link:${page.pageId}`, () => linkMetaPageAction(page.pageId))}
                    >
                      Link<span className="sr-only"> Page {page.pageId}</span>
                    </Button>
                  )
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {messageFor("held")}
    </SettingsCard>
  );
}
