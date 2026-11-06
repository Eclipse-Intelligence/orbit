"use client";

import { useEffect, useId, useState } from "react";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import { Label } from "@/components/_ui/label";
import { NativeSelect } from "@/components/_ui/native-select";
import { moveRecordsAction, previewMoveAction } from "@/app/(crm)/move-workspace";
import type { MovePipeline, MovePreview } from "@/lib/crm/move-workspace";
import type { WorkspaceRef } from "@/lib/crm/workspaces";

export type MoveKind = "company" | "contact";

const MATCHING = "";

function counted(value: number, one: string, many: string) {
  return value > 0 ? `${value} ${value === 1 ? one : many}` : null;
}

function listed(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function defaultStage(pipeline: MovePipeline | undefined, dealStages: string[]) {
  if (!pipeline) return MATCHING;
  if (dealStages.length > 1) return MATCHING;
  const wanted = dealStages[0]?.trim().toLowerCase();
  const same = pipeline.stages.find((stage) => stage.name.trim().toLowerCase() === wanted);
  return same?.id ?? pipeline.stages[0]?.id ?? MATCHING;
}

function summaryLines(preview: MovePreview, copy: boolean, copyDeals: boolean) {
  const deals = copy ? (copyDeals ? preview.dealsAvailable : 0) : preview.deals;
  const parts = [
    counted(preview.contacts, "contact", "contacts"),
    counted(deals, "deal", "deals"),
    counted(preview.activities, "activity", "activities"),
    copy ? null : counted(preview.tasks, "task", "tasks"),
    copy ? null : counted(preview.files, "file", "files"),
  ].filter((part): part is string => Boolean(part));
  const target = preview.target.name;
  const lines: string[] = [];
  lines.push(parts.length > 0 ? `${copy ? "Copies" : "Goes with it"}: ${parts.join(", ")}.` : copy ? "Copies the details only." : "Nothing else goes with it.");
  if (preview.companiesAlong.length > 0) lines.push(`${listed(preview.companiesAlong)} ${preview.companiesAlong.length === 1 ? "comes" : "come"} too.`);
  for (const link of preview.links) {
    lines.push(link.matched ? `Linked to ${link.into} in ${target}.` : `${link.name} stays here, and a copy goes to ${target}.`);
  }
  for (const merge of preview.merges) lines.push(`${merge.name} merges into ${merge.into}.`);
  if (!copy && preview.boards.length > 0) lines.push(`Comes off ${listed(preview.boards)}.`);
  if (preview.aiFields.length > 0) lines.push(`Stays behind: AI fields ${listed(preview.aiFields)}.`);
  return lines;
}

type MoveDialogProps = {
  kind: MoveKind;
  ids: string[];
  subject: string;
  currentWorkspace: string;
  workspaces: WorkspaceRef[];
  onDone: (result: { message: string; copy: boolean }) => void;
};

export default function MoveWorkspaceDialog({
  open,
  onOpenChange,
  ...props
}: MoveDialogProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        {open && <MoveBody {...props} busy={busy} setBusy={setBusy} close={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function MoveBody({
  kind,
  ids,
  subject,
  currentWorkspace,
  workspaces,
  onDone,
  busy,
  setBusy,
  close,
}: MoveDialogProps & { busy: boolean; setBusy: (busy: boolean) => void; close: () => void }) {
  const fieldIds = { workspace: useId(), pipeline: useId(), stage: useId(), keep: useId(), deals: useId() };
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [copy, setCopy] = useState(false);
  const [copyDeals, setCopyDeals] = useState(false);
  const [pipelineId, setPipelineId] = useState("");
  const [stageId, setStageId] = useState(MATCHING);
  const [loaded, setLoaded] = useState<{ key: string; preview: MovePreview | null; error: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idsKey = ids.join(",");
  const requestKey = JSON.stringify([idsKey, workspaceId, copy, copyDeals, pipelineId]);

  useEffect(() => {
    if (!workspaceId || !idsKey) return;
    let live = true;
    void previewMoveAction({
      [kind === "company" ? "companyIds" : "contactIds"]: idsKey.split(","),
      workspaceId,
      copy,
      copyDeals,
      pipelineId: pipelineId || null,
    }).then((result) => {
      if (!live) return;
      const next = result.preview ?? null;
      setLoaded({ key: requestKey, preview: next, error: next ? null : (result.error ?? "Couldn't check what moves. Try again.") });
      if (next && !pipelineId && next.pipelineId) {
        setPipelineId(next.pipelineId);
        setStageId(defaultStage(next.pipelines.find((item) => item.id === next.pipelineId), next.dealStages));
      }
    });
    return () => {
      live = false;
    };
  }, [requestKey, idsKey, kind, workspaceId, copy, copyDeals, pipelineId]);

  const preview = loaded?.preview ?? null;
  const loading = loaded?.key !== requestKey;
  const target = workspaces.find((item) => item.id === workspaceId);
  const pipelines = preview?.pipelines ?? [];
  const pipeline = pipelines.find((item) => item.id === pipelineId);
  const hasDeals = Boolean(preview && (copy ? preview.dealsAvailable > 0 : preview.deals > 0));
  const showDeals = hasDeals && (!copy || copyDeals) && pipelines.length > 0;
  const lines = preview ? summaryLines(preview, copy, copyDeals) : [];
  const blocked = Boolean(showDeals && preview?.boardConflict && pipeline?.kind === "board");
  const shownError = error ?? (loading ? null : (loaded?.error ?? null));

  async function run() {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    const result = await moveRecordsAction({
      [kind === "company" ? "companyIds" : "contactIds"]: ids,
      workspaceId,
      copy,
      copyDeals: copy && copyDeals,
      pipelineId: showDeals ? pipelineId || null : null,
      stageId: showDeals ? stageId || null : null,
    });
    setBusy(false);
    if (result.error || !result.message) {
      setError(result.error ?? "That didn't move. Try again.");
      return;
    }
    close();
    onDone({ message: result.message, copy: result.copy === true });
  }

  return (
    <>
      <DialogHeader className="pr-12">
        <DialogTitle>{`${copy ? "Copy" : "Move"} ${subject}`}</DialogTitle>
        <DialogDescription>
          {copy ? `${currentWorkspace} keeps it, and ${target?.name ?? "the other workspace"} gets a copy.` : `It leaves ${currentWorkspace}.`}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4 px-6 py-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor={fieldIds.workspace}>Workspace</Label>
          <NativeSelect
            id={fieldIds.workspace}
            value={workspaceId}
            disabled={busy}
            onChange={(event) => {
              setWorkspaceId(event.target.value);
              setPipelineId("");
              setStageId(MATCHING);
              setError(null);
            }}
          >
            {workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <label htmlFor={fieldIds.keep} className="caption-style text-soft flex cursor-pointer items-center gap-2">
          <Checkbox id={fieldIds.keep} checked={copy} disabled={busy} onCheckedChange={(value) => setCopy(value === true)} />
          Also keep in {currentWorkspace}
        </label>
        {copy && hasDeals && (
          <label htmlFor={fieldIds.deals} className="caption-style text-soft flex cursor-pointer items-center gap-2">
            <Checkbox id={fieldIds.deals} checked={copyDeals} disabled={busy} onCheckedChange={(value) => setCopyDeals(value === true)} />
            Copy deals too
          </label>
        )}
        {showDeals && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor={fieldIds.pipeline}>Put deals on</Label>
              <NativeSelect
                id={fieldIds.pipeline}
                value={pipelineId}
                disabled={busy}
                onChange={(event) => {
                  const next = pipelines.find((item) => item.id === event.target.value);
                  setPipelineId(event.target.value);
                  setStageId(defaultStage(next, preview?.dealStages ?? []));
                }}
              >
                {pipelines.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.kind === "board" ? item.name : "Pipeline"}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={fieldIds.stage}>Stage</Label>
              <NativeSelect id={fieldIds.stage} value={stageId} disabled={busy} onChange={(event) => setStageId(event.target.value)}>
                {(preview?.dealStages.length ?? 0) > 1 && <option value={MATCHING}>Same as now</option>}
                {(pipeline?.stages ?? []).map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
        )}
        <div role="status" aria-live="polite" className="caption-style text-soft flex min-h-10 flex-col gap-1">
          {!preview && loading ? <span>Checking what goes with it…</span> : lines.map((line) => <span key={line}>{line}</span>)}
        </div>
        {blocked && (
          <p role="alert" className="caption-style text-danger">
            {preview?.boardConflict} would have more than one card on {pipeline?.name}. Put the deals on the pipeline.
          </p>
        )}
        {shownError && (
          <p role="alert" className="caption-style text-danger">
            {shownError}
          </p>
        )}
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost" size="md" disabled={busy}>
            Cancel
          </Button>
        </DialogClose>
        <Button variant="primary" size="md" disabled={busy || loading || !preview || blocked || !workspaceId} onClick={() => void run()}>
          {busy ? (copy ? "Copying…" : "Moving…") : copy ? "Copy" : "Move"}
        </Button>
      </DialogFooter>
    </>
  );
}
