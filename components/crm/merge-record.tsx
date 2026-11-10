"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
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

const CHOOSE = {
  company: "Choose a company",
  contact: "Choose a contact",
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
  const [target, setTarget] = useState<PickedRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      return;
    }
    router.push(kind === "company" ? companyHref(result.keptId) : contactHref(result.keptId));
  }

  return (
    <>
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
              setTarget(null);
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
      <Dialog open={picking} onOpenChange={(open) => !busy && setPicking(open)}>
        <DialogContent>
          <DialogHeader className="pr-12">
            <DialogTitle>Merge {name} into…</DialogTitle>
            <DialogDescription>{name} is archived after the merge.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 px-6 py-5">
            <Label htmlFor={pickerId}>Keep</Label>
            <RecordPicker id={pickerId} kind={kind} value={target} onChange={setTarget} placeholder={CHOOSE[kind]} excludeId={id} />
            {target && <p className="caption-style text-soft">Everything on {name} moves to {target.name}. Details {target.name} already has are kept.</p>}
            {error && (
              <p role="alert" className="caption-style text-danger">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="md" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="primary" size="md" disabled={!target || busy} onClick={() => void merge()}>
              {busy ? "Merging…" : "Merge"}
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
    </>
  );
}
