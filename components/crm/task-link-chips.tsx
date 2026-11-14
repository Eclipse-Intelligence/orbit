"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { SearchChip } from "@/components/crm/task-pad";
import { useComposer } from "@/components/mail/compose-dock";
import { EditTaskDocs, TASK_EDIT_CHIP, TaskDocChips } from "@/components/crm/task-docs";
import { relinkTaskAction } from "@/app/(crm)/task-act";
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
const EMAIL_UNDO_MS = 5000;

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

function EmailChip({ task, busy, onRemove }: { task: Task; busy: boolean; onRemove: () => void }) {
  if (!task.mailThreadKey) return null;
  const readable = Boolean(task.mailThread?.readable);
  const name = readable ? task.mailThread?.subject || "Email" : "Email";
  return (
    <span className={TASK_EDIT_CHIP}>
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
        disabled={busy}
        aria-label={readable ? `Remove link to ${name}` : "Remove link to an email"}
        title="Remove"
        onClick={onRemove}
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
  const saving = useRef(false);
  const lastSlot = useRef<string | null>(null);
  const pendingEmail = useRef<{ timer: number; taskId: string } | null>(null);
  const [hiddenEmail, setHiddenEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const unlinked = !task.companyId && !task.contactId && !task.opportunityId;
  const named = useNamedPeople(task, unlinked);

  useEffect(
    () => () => {
      const pending = pendingEmail.current;
      if (!pending) return;
      window.clearTimeout(pending.timer);
      pendingEmail.current = null;
      void relinkTaskAction(pending.taskId, { mailThreadKey: null }).catch(() => null);
    },
    [],
  );

  async function save(next: LinkChange, message: string | null) {
    if (saving.current) return false;
    saving.current = true;
    setBusy(true);
    setError(null);
    setNote(null);
    const result = await relinkTaskAction(task.id, next).catch(() => ({ error: LINK_FAILED }));
    saving.current = false;
    setBusy(false);
    const slot = lastSlot.current;
    if (slot) {
      window.requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        group.current?.querySelector<HTMLElement>(`[data-link-slot="${slot}"] button`)?.focus();
      });
    }
    if (result.error) {
      setError(result.error);
      return false;
    }
    setNote(message);
    router.refresh();
    return true;
  }

  function change(kind: "company" | "contact" | "opportunity", option: Parameters<typeof relinkChange>[2]) {
    lastSlot.current = kind;
    const next = relinkChange(task, kind, option);
    void save(next, relinkNote(task, kind, next));
  }

  function removeEmail() {
    const key = task.mailThreadKey;
    if (!key || pendingEmail.current) return;
    setHiddenEmail(key);
    const timer = window.setTimeout(() => {
      pendingEmail.current = null;
      lastSlot.current = null;
      void save({ mailThreadKey: null }, null).then((ok) => {
        if (!ok) setHiddenEmail(null);
      });
    }, EMAIL_UNDO_MS);
    pendingEmail.current = { timer, taskId: task.id };
    composer.showToast({
      message: "Email link removed.",
      duration: EMAIL_UNDO_MS,
      action: {
        label: "Undo",
        run: () => {
          const pending = pendingEmail.current;
          if (pending) window.clearTimeout(pending.timer);
          pendingEmail.current = null;
          setHiddenEmail(null);
        },
      },
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
      {hiddenEmail !== task.mailThreadKey && <EmailChip task={task} busy={busy} onRemove={removeEmail} />}
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
