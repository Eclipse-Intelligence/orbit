"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { SearchChip } from "@/components/crm/task-pad";
import { useComposer } from "@/components/mail/compose-dock";
import { EditTaskDocs, TASK_EDIT_CHIP, TaskDocChips } from "@/components/crm/task-docs";
import { forgetLinkUndo, linkUndoOffered, offerLinkUndo } from "@/lib/task-link-undo";
import { relinkTaskAction, undoTaskLinkAction } from "@/app/(crm)/task-act";
import { taskLinkCandidatesAction } from "@/app/(crm)/records";
import type { PadOption } from "@/lib/crm/task-pad";
import type { LinkChange } from "@/lib/crm/task-act";
import type { Task } from "@/lib/crm/types";
import { threadHref } from "@/lib/mail/view";
import { relinkChange, relinkNote } from "@/lib/task-pad";
import XIcon from "@/public/assets/images/companies/detail/x.svg";
import OpportunityIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import MailIcon from "@/public/assets/images/mail/mail-open.svg";
import UserIcon from "@/public/assets/images/tasks/user.svg";

const LINK_FAILED = "Couldn't link the task. Try again.";
const SLOT = "inline-flex min-w-0 max-w-full [&>button]:hit";
const EMAIL_UNDO_MS = 8000;
const UNDO_FAILED = "Couldn't undo. Try again.";

type Saved = { ok?: boolean; undo?: string | null; error?: string };

function useNamedPeople(task: Task, wanted: boolean) {
  const [found, setFound] = useState<{ key: string; people: PadOption[] } | null>(null);
  const key = `${task.id}|${task.title}`;
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    void taskLinkCandidatesAction(task.id)
      .catch(() => ({ candidates: [] }))
      .then((result) => {
        if (cancelled) return;
        const people = (result.candidates ?? [])
          .filter((candidate) => candidate.kind === "contact")
          .map((candidate) => ({ id: candidate.id, name: candidate.name, detail: candidate.detail, company: candidate.company ?? null }));
        setFound({ key, people });
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, key, task.id]);
  return wanted && found?.key === key ? found.people : [];
}

function EmailChip({ task, onRemove }: { task: Task; onRemove: (chip: HTMLElement | null) => void }) {
  if (!task.mailThreadKey) return null;
  const readable = Boolean(task.mailThread?.readable);
  const name = readable ? task.mailThread?.subject || "Email" : "Email";
  return (
    <span data-email-chip="" className={TASK_EDIT_CHIP}>
      <MailIcon aria-hidden />
      {readable ? (
        <Link href={threadHref(task.mailThreadKey)} className="truncate hover:underline">
          {name}
        </Link>
      ) : (
        <span className="truncate">{name}</span>
      )}
      <Button
        variant="ghost"
        size="none"
        aria-label={readable ? `Remove link to ${name}` : "Remove link to an email"}
        title="Remove"
        onClick={(event) => onRemove(event.currentTarget.closest<HTMLElement>("[data-email-chip]"))}
        className="hit size-5 shrink-0 rounded-full [@media(pointer:coarse)]:ml-3"
      >
        <XIcon aria-hidden />
      </Button>
    </span>
  );
}

export default function TaskLinkChips({ task, warn }: { task: Task; warn: boolean }) {
  const router = useRouter();
  const composer = useComposer();
  const group = useRef<HTMLDivElement>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const lastSlot = useRef<string | null>(null);
  const [hiddenEmail, setHiddenEmail] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const unlinked = !task.companyId && !task.contactId && !task.opportunityId;
  const named = useNamedPeople(task, unlinked);
  const busy = pending > 0;
  if (hiddenEmail && hiddenEmail !== task.mailThreadKey) setHiddenEmail(null);

  function save(next: LinkChange, message: string | null, options: { quiet?: boolean } = {}): Promise<Saved> {
    setPending((count) => count + 1);
    setError(null);
    setNote(null);
    const run = queue.current.then(async (): Promise<Saved> => {
      let result: Saved;
      try {
        result = await relinkTaskAction(task.id, next);
      } catch {
        result = { error: LINK_FAILED };
      } finally {
        setPending((count) => count - 1);
      }
      const slot = lastSlot.current;
      if (slot) {
        window.requestAnimationFrame(() => {
          if (document.activeElement && document.activeElement !== document.body) return;
          group.current?.querySelector<HTMLElement>(`[data-link-slot="${slot}"] button`)?.focus();
        });
      }
      if (result.error) {
        if (!options.quiet) setError(result.error);
        return result;
      }
      setNote(message);
      router.refresh();
      return result;
    });
    queue.current = run.catch(() => undefined);
    return run.catch((): Saved => ({ error: LINK_FAILED }));
  }

  function change(kind: "company" | "contact" | "opportunity", option: Parameters<typeof relinkChange>[2]) {
    lastSlot.current = kind;
    const next = relinkChange(task, kind, option);
    void save(next, relinkNote(task, kind, next));
  }

  function nextFocus(chip: HTMLElement | null) {
    const targets = [...(group.current?.querySelectorAll<HTMLElement>("button, a[href]") ?? [])].filter((element) => !chip?.contains(element));
    const after = targets.find((element) => chip && chip.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    return after ?? targets[targets.length - 1] ?? null;
  }

  function removeEmail(chip: HTMLElement | null) {
    const key = task.mailThreadKey;
    if (!key) return;
    const taskId = task.id;
    const focus = nextFocus(chip);
    setHiddenEmail(key);
    window.requestAnimationFrame(() => focus?.focus());
    lastSlot.current = null;
    void save({ mailThreadKey: null }, null, { quiet: true }).then((result) => {
      if (result.error) {
        setHiddenEmail(null);
        composer.showToast({ message: result.error, tone: "alert" });
        return;
      }
      const eventId = result.undo;
      if (!eventId) return;
      let toast: number | null = null;
      const undo = () => {
        forgetLinkUndo(undo);
        if (toast !== null) composer.dismissToast(toast);
        void undoTaskLinkAction(taskId, eventId)
          .catch(() => ({ error: UNDO_FAILED }))
          .then((undone) => {
            if (undone.error) {
              composer.showToast({ message: undone.error, tone: "alert" });
              return;
            }
            setHiddenEmail(null);
            router.refresh();
          });
      };
      offerLinkUndo(undo, EMAIL_UNDO_MS);
      toast = composer.showToast({ message: "Email link removed.", duration: EMAIL_UNDO_MS, action: { label: "Undo", run: undo, shortcut: () => linkUndoOffered(undo) }, onDismiss: () => forgetLinkUndo(undo) });
    });
  }

  function refocus(slot: string) {
    window.requestAnimationFrame(() => group.current?.querySelector<HTMLElement>(`[data-link-slot="${slot}"] button`)?.focus());
  }

  const record = (id: string | null, name: string | null) => (id && name ? { id, name } : null);
  return (
    <div
      ref={group}
      role="group"
      aria-label="Linked"
      aria-busy={busy || undefined}
      className="flex min-w-0 flex-wrap items-center gap-1.5 [@media(pointer:coarse)]:gap-x-2.5 [@media(pointer:coarse)]:gap-y-4"
    >
      <span inert={busy} className="contents">
        <span data-link-slot="contact" className={SLOT}>
          <SearchChip
            kind="contact"
            icon={UserIcon}
            label="Person"
            value={record(task.contactId, task.contactName)}
            companyId={task.companyId}
            variant="card"
            taskId={task.id}
            suggested={named.length > 0 ? { heading: "Named in this task", options: named } : undefined}
            onPick={(option) => change("contact", option)}
            onClosed={() => refocus("contact")}
          />
        </span>
        <span data-link-slot="company" className={SLOT}>
          <SearchChip
            kind="company"
            icon={BuildingIcon}
            label="Company"
            value={record(task.companyId, task.companyName)}
            companyId={null}
            variant="card"
            taskId={task.id}
            onPick={(option) => change("company", option)}
            onClosed={() => refocus("company")}
          />
        </span>
        <span data-link-slot="opportunity" className={SLOT}>
          <SearchChip
            kind="opportunity"
            icon={OpportunityIcon}
            label="Opportunity"
            value={record(task.opportunityId, task.opportunityName)}
            companyId={null}
            variant="card"
            taskId={task.id}
            onPick={(option) => change("opportunity", option)}
            onClosed={() => refocus("opportunity")}
          />
        </span>
      </span>
      {hiddenEmail !== task.mailThreadKey && <EmailChip task={task} onRemove={removeEmail} />}
      {task.canLinkDocs ? <EditTaskDocs task={task} warn={warn} /> : <TaskDocChips task={task} />}
      {busy && (
        <span role="status" className="caption-style text-subtle">
          Saving…
        </span>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger basis-full">
          {error}
        </p>
      )}
      {note && !error && (
        <p role="status" className="caption-style text-subtle basis-full">
          {note}
        </p>
      )}
    </div>
  );
}
