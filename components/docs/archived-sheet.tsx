"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Button from "@/components/_ui/button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import { Sheet, SheetCloseButton, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/_ui/sheet";
import { archivedDocsAction, takeOverDocsAction, type ArchivedDocs, type FormerMember } from "@/app/(crm)/docs/manage-actions";
import { refreshDocsAfterRestore, restoreFolder } from "@/components/docs/docs-manage";
import { useDocsNavigate, useDocsNow } from "@/components/docs/use-docs";
import { docsData } from "@/lib/docs/connection";
import { shortDay, whenLabel } from "@/lib/docs/format";
import { useDocsStore } from "@/stores/docs-store";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import SunIcon from "@/public/assets/images/docs/sun.svg";
import FolderIcon from "@/public/assets/images/mail/folder.svg";

type Loaded = { data: ArchivedDocs; error: null } | { data: null; error: string };

function Row({ icon, name, detail, busy, onRestore }: { icon: ReactNode; name: string; detail: string; busy: boolean; onRestore: () => void }) {
  return (
    <li className="flex min-h-11 items-center gap-3 rounded-xl px-2 py-1.5">
      <span className="text-subtle flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-foreground truncate text-[14px] leading-5">{name}</span>
        <span className="caption-style text-subtle">{detail}</span>
      </span>
      <Button variant="secondary" size="sm" disabled={busy} onClick={onRestore} aria-label={`Restore ${name}`}>
        Restore
      </Button>
    </li>
  );
}

export default function ArchivedSheet() {
  const params = useSearchParams();
  const open = params.get("archived") === "1";
  const navigate = useDocsNavigate();
  const now = useDocsNow();
  const notify = useDocsStore((state) => state.notify);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [takeOver, setTakeOver] = useState<FormerMember | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void archivedDocsAction()
      .then((result) => {
        if (!live) return;
        setLoaded(result.error !== undefined ? { data: null, error: result.error } : { data: result.data, error: null });
      })
      .catch(() => {
        if (live) setLoaded({ data: null, error: "Archived didn't load. Try again." });
      });
    return () => {
      live = false;
    };
  }, [open, reload]);

  function close() {
    setProblem(null);
    navigate("/docs", { replace: true });
  }

  async function run(id: string, action: () => Promise<string | null>) {
    setBusy(id);
    setProblem(null);
    const failed = await action();
    setBusy(null);
    if (failed) setProblem(failed);
    else setReload((value) => value + 1);
  }

  function restoreNote(id: string, name: string) {
    void run(id, async () => {
      try {
        await docsData().restorePage(id);
        await refreshDocsAfterRestore();
        notify(`Restored ${name}.`);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : `Couldn't restore ${name}.`;
      }
    });
  }

  function confirmTakeOver(member: FormerMember) {
    void run(member.id, async () => {
      const result = await takeOverDocsAction(member.id);
      if (result.error !== undefined) return result.error;
      await refreshDocsAfterRestore();
      notify(`${result.data.docs} ${result.data.docs === 1 ? "note" : "notes"} and ${result.data.folders} ${result.data.folders === 1 ? "folder" : "folders"} are now yours.`);
      return null;
    });
  }

  const data = loaded?.data ?? null;
  const empty = data && data.folders.length === 0 && data.notes.length === 0;

  return (
    <Sheet open={open} onOpenChange={(next) => !next && close()}>
      <SheetContent side="right" className="sm:w-[26rem] sm:max-w-[26rem]">
        <SheetHeader className="px-4">
          <SheetTitle>Archived</SheetTitle>
          <SheetCloseButton />
        </SheetHeader>
        <SheetDescription className="sr-only">Archived notes and folders you can restore</SheetDescription>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-10">
          {!loaded && (
            <p role="status" className="caption-style text-subtle px-2">
              Loading
            </p>
          )}
          {loaded?.error && (
            <p role="alert" className="caption-style text-danger px-2">
              {loaded.error}
            </p>
          )}
          {problem && (
            <p role="alert" className="caption-style text-danger px-2 pb-2">
              {problem}
            </p>
          )}
          {empty && <p className="caption-style text-subtle px-2">Nothing archived.</p>}
          {data && data.folders.length > 0 && (
            <section aria-labelledby="archived-folders" className="pb-3">
              <h2 id="archived-folders" className="eyebrow-style text-subtle px-2 pb-1 text-[11px]">
                Folders
              </h2>
              <ul className="flex flex-col">
                {data.folders.map((folder) => (
                  <Row
                    key={folder.id}
                    icon={<FolderIcon aria-hidden className="size-3.5" />}
                    name={folder.name}
                    detail={`${whenLabel(folder.archivedAt, now)} · with its notes`}
                    busy={busy !== null}
                    onRestore={() => void run(folder.id, () => restoreFolder(folder.id, folder.name))}
                  />
                ))}
              </ul>
            </section>
          )}
          {data && data.notes.length > 0 && (
            <section aria-labelledby="archived-notes" className="pb-3">
              <h2 id="archived-notes" className="eyebrow-style text-subtle px-2 pb-1 text-[11px]">
                Notes
              </h2>
              <ul className="flex flex-col">
                {data.notes.map((note) => {
                  const name = note.kind === "daily" && note.dailyDate ? shortDay(note.dailyDate) : note.title || "Untitled";
                  return (
                    <Row
                      key={note.id}
                      icon={note.kind === "daily" ? <SunIcon aria-hidden className="size-3.5" /> : <DocIcon aria-hidden className="size-3.5" />}
                      name={name}
                      detail={whenLabel(note.archivedAt, now)}
                      busy={busy !== null}
                      onRestore={() => restoreNote(note.id, name)}
                    />
                  );
                })}
              </ul>
            </section>
          )}
          {data?.formerMembers && (
            <section aria-labelledby="former-members" className="border-line-strong mt-2 border-t px-2 pt-4">
              <h2 id="former-members" className="eyebrow-style text-subtle pb-1 text-[11px]">
                Former members&apos; docs
              </h2>
              <p className="caption-style text-subtle pb-2">Admins only. Take over someone&apos;s notes and folders after they leave the workspace.</p>
              {data.formerMembers.length === 0 ? (
                <p className="caption-style text-subtle">No former members&apos; docs you can see.</p>
              ) : (
                <ul className="flex flex-col">
                  {data.formerMembers.map((member) => (
                    <li key={member.id} className="flex min-h-11 items-center gap-3 py-1.5">
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-foreground truncate text-[14px] leading-5">{member.name}</span>
                        <span className="caption-style text-subtle truncate">{member.examples.join(", ")}</span>
                      </span>
                      <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => setTakeOver(member)}>
                        Take over
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </SheetContent>
      <ConfirmDialog
        open={takeOver !== null}
        onOpenChange={(next) => !next && setTakeOver(null)}
        tone="neutral"
        title={`Take over ${takeOver?.name ?? ""}'s docs?`}
        description="Their notes and folders, private ones included, become yours. Shared ones stay shared. Their daily notes stay with them."
        confirmLabel="Take over"
        onConfirm={() => {
          if (takeOver) confirmTakeOver(takeOver);
        }}
      />
    </Sheet>
  );
}
