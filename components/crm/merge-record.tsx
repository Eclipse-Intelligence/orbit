"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import { Label } from "@/components/_ui/label";
import RecordPicker, { type PickedRecord } from "@/components/crm/record-picker";
import { mergeCompanyAction } from "@/app/(crm)/actions";
import { mergeContactAction } from "@/app/(crm)/records";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
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

export default function MergeRecordMenu({ kind, id, name }: { kind: "company" | "contact"; id: string; name: string }) {
  const router = useRouter();
  const pickerId = useId();
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState<PickedRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[kind];

  async function merge() {
    if (!target) return;
    setBusy(true);
    setError(null);
    const result = kind === "company" ? await mergeCompanyAction(id, target.id) : await mergeContactAction(id, target.id);
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
