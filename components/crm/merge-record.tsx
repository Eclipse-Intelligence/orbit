"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import { Label } from "@/components/_ui/label";
import MoveWorkspaceDialog from "@/components/crm/move-workspace-dialog";
import RecordPicker, { type PickedRecord } from "@/components/crm/record-picker";
import { mergeCompanyAction } from "@/app/(crm)/actions";
import { mergeContactAction } from "@/app/(crm)/records";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import type { WorkspaceRef } from "@/lib/crm/workspaces";
import MoreIcon from "@/public/assets/images/_common/more.svg";

const COPY = {
  company: {
    choose: "Choose a company",
    moves: "People, deals, tasks, activity, emails, proposals and Knowledge",
  },
  contact: {
    choose: "Choose a person",
    moves: "Activity, tasks, deals, emails and proposals",
  },
} as const;

const NOTICE_MS = 6000;

export default function MergeRecordMenu({
  kind,
  id,
  name,
  moveTargets = [],
  workspaceName = "",
}: {
  kind: "company" | "contact";
  id: string;
  name: string;
  moveTargets?: WorkspaceRef[];
  workspaceName?: string;
}) {
  const router = useRouter();
  const [moving, setMoving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pickerId = useId();
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState<PickedRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[kind];

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function merge() {
    if (!target) return;
    setBusy(true);
    setError(null);
    const result = kind === "company" ? await mergeCompanyAction(target.id, id) : await mergeContactAction(target.id, id);
    if (result.error || !result.keptId) {
      setBusy(false);
      setError(result.error ?? "That didn't merge. Try again.");
      setPicking(true);
      return;
    }
    router.push(kind === "company" ? companyHref(result.keptId) : contactHref(result.keptId));
  }

  return (
    <>
      {busy && (
        <span role="status" className="ui-style whitespace-nowrap text-subtle">
          Merging…
        </span>
      )}
      {notice && (
        <span role="status" className="ui-style max-w-[16em] truncate text-subtle">
          {notice}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="icon" aria-label="More actions" title="More" disabled={busy}>
            <MoreIcon aria-hidden className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            onSelect={() => {
              setError(null);
              setPicking(true);
            }}
          >
            Merge into…
          </DropdownMenuItem>
          {moveTargets.length > 0 && (
            <DropdownMenuItem
              onSelect={() => {
                setNotice(null);
                setMoving(true);
              }}
            >
              Move to workspace…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent>
          <DialogHeader className="pr-12">
            <DialogTitle>Merge {name} into…</DialogTitle>
            <DialogDescription>Pick the record to keep. {name} is archived after the merge.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 px-6 py-5">
            <Label htmlFor={pickerId}>Keep</Label>
            <RecordPicker id={pickerId} kind={kind} value={target} onChange={setTarget} placeholder={copy.choose} excludeId={id} />
            {error && (
              <p role="alert" className="caption-style text-danger">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="md">
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="primary"
              size="md"
              disabled={!target || busy}
              onClick={() => {
                setPicking(false);
                setConfirming(true);
              }}
            >
              {busy ? "Merging…" : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {moveTargets.length > 0 && (
        <MoveWorkspaceDialog
          open={moving}
          onOpenChange={setMoving}
          kind={kind}
          ids={[id]}
          subject={name}
          currentWorkspace={workspaceName}
          workspaces={moveTargets}
          onDone={(result) => {
            if (result.copy) {
              setNotice(result.message);
              router.refresh();
              return;
            }
            router.push(kind === "company" ? "/" : "/contacts");
          }}
        />
      )}
      {target && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Merge into ${target.name}?`}
          description={`${copy.moves} move from ${name} to ${target.name}. Empty details on ${target.name} are filled from ${name} and tags are combined. ${name} is then archived.`}
          confirmLabel="Merge"
          onConfirm={() => void merge()}
        />
      )}
    </>
  );
}
