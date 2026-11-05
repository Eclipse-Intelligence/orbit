"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import { Monogram, tagBase } from "@/components/beautifui/record-marks";
import { FilePicker } from "@/components/crm/unfiled-conversations";
import WorkspaceTile from "@/components/workspaces/workspace-tile";
import { createAndFileEmailAction, fileEmailToAction, ignoreEmailAction, moveEmailAction } from "@/app/(crm)/capture/actions";
import { contactHref } from "@/lib/crm/hrefs";
import type { UnknownEmail } from "@/lib/mail/filing";
import { mailDayWhen } from "@/lib/mail/format";
import type { WorkspaceChoiceRef } from "@/lib/mail/view";
import { KEYBOARD_ROW_CLASS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

type Notice = { contactId: string; name: string } | { moved: string } | null;

function senderLabel(email: UnknownEmail) {
  return email.name || email.email;
}

export default function UnknownMail({
  emails,
  workspaces,
  currentId,
  now,
}: {
  emails: UnknownEmail[];
  workspaces: WorkspaceChoiceRef[];
  currentId: string;
  now: number;
}) {
  const [notice, setNotice] = useState<Notice>(null);
  if (emails.length === 0 && !notice) return null;
  const others = workspaces.filter((item) => item.id !== currentId);
  return (
    <section className="flex flex-col gap-2" aria-labelledby="unknown-email-heading">
      <h3 id="unknown-email-heading" className="h4-style">
        Email from people not in Orbit
      </h3>
      <p role="status" className={notice ? "caption-style text-soft" : "sr-only"}>
        {notice && "contactId" in notice && (
          <>
            Filed to{" "}
            <Button variant="link" size="none" href={contactHref(notice.contactId)}>
              {notice.name}
            </Button>
          </>
        )}
        {notice && "moved" in notice && `Moved to ${notice.moved}'s Capture`}
      </p>
      {emails.length === 0 ? (
        <p className="caption-style text-subtle">No new email from people outside Orbit.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {emails.map((email) => (
            <EmailCard key={email.key} email={email} others={others} now={now} onNotice={setNotice} />
          ))}
        </ul>
      )}
    </section>
  );
}

function EmailCard({
  email,
  others,
  now,
  onNotice,
}: {
  email: UnknownEmail;
  others: WorkspaceChoiceRef[];
  now: number;
  onNotice: (notice: Notice) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"create" | "move" | "ignore" | null>(null);
  const [filing, setFiling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = senderLabel(email);

  async function create() {
    if (pending) return;
    setPending("create");
    setError(null);
    const result = await createAndFileEmailAction(email.key);
    setPending(null);
    if (result.error || !result.contactId) {
      setError(result.error ?? "Could not file this email.");
      return;
    }
    onNotice({ contactId: result.contactId, name: result.contactName ?? label });
    router.refresh();
  }

  async function move(target: WorkspaceChoiceRef) {
    if (pending) return;
    setPending("move");
    setError(null);
    const result = await moveEmailAction(email.key, target.id);
    setPending(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    onNotice({ moved: target.name });
    router.refresh();
  }

  async function ignore() {
    if (pending) return;
    setPending("ignore");
    setError(null);
    const result = await ignoreEmailAction(email.key);
    setPending(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <li data-list-row="" className={cn(KEYBOARD_ROW_CLASS, "bg-card border-line-strong flex flex-col gap-3 rounded-2xl border p-4")}>
      <div className="flex items-start gap-2.5">
        <Monogram name={label} className="mt-px size-6 rounded-full text-[11px]" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[14px] leading-5">{label}</span>
            <span className="caption-style text-subtle ml-auto shrink-0 tabular-nums">{mailDayWhen(email.at, now)}</span>
          </span>
          <span className="caption-style text-subtle flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 leading-[1.4]">
            <span className="min-w-0 truncate">{email.email}</span>
            <span aria-hidden className="max-sm:hidden">
              ·
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: tagBase(email.address) }} />
              <span className="truncate">To {email.address}</span>
            </span>
          </span>
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[14px] leading-5">{email.subject?.trim() || "(no subject)"}</span>
        {email.snippet && <p className="caption-style text-soft line-clamp-2 leading-[1.5]">{email.snippet}</p>}
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      {filing ? (
        <FilePicker
          id={email.messageId}
          onPick={(contact) => fileEmailToAction(email.key, contact.id)}
          onCancel={() => setFiling(false)}
          onDone={() => {
            setFiling(false);
            router.refresh();
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" className="max-w-full" disabled={pending !== null} onClick={create} data-row-key="a" title="Create contact and file (A)">
            <span className="truncate">{pending === "create" ? "Creating…" : `Create ${label} & file`}</span>
          </Button>
          <Button variant="secondary" size="sm" disabled={pending !== null} onClick={() => setFiling(true)} data-row-key="f" title="File to… (F)">
            File to…
          </Button>
          {others.length === 1 ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={pending !== null}
              onClick={() => void move(others[0])}
              title={`Move to ${others[0].name}'s Capture`}
            >
              <WorkspaceTile id={others[0].id} name={others[0].name} className="size-4 rounded-[5px] text-[9px]" />
              {pending === "move" ? "Moving…" : `Move to ${others[0].name}`}
            </Button>
          ) : others.length > 1 ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" disabled={pending !== null} title="Move to another workspace's Capture">
                  {pending === "move" ? "Moving…" : "Move to"}
                  <ChevronDownIcon aria-hidden className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[14rem]">
                {others.map((item) => (
                  <DropdownMenuItem key={item.id} className="max-sm:py-2.5" onSelect={() => void move(item)}>
                    <WorkspaceTile id={item.id} name={item.name} className="size-4 rounded-[5px] text-[9px]" />
                    {item.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Button variant="ghost" size="sm" disabled={pending !== null} onClick={ignore} data-row-key="i" title="Ignore (I)">
            {pending === "ignore" ? "Ignoring…" : "Ignore"}
          </Button>
        </div>
      )}
    </li>
  );
}
