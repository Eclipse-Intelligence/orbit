"use client";

import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { folderSharingAction } from "@/app/(crm)/docs/manage-actions";
import Button from "@/components/_ui/button";
import CopyButton from "@/components/_ui/copy-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { Radio } from "@/components/_ui/radio";
import { ParticipantAvatar } from "@/components/docs/presence";
import { useDocsNav, useMedia } from "@/components/docs/use-docs";
import type { Folder, PageSummary, Visibility } from "@/lib/docs/client-types";
import { listHref, pageHref } from "@/lib/docs/routes";
import { useDocsStore } from "@/stores/docs-store";
import { cn } from "@/lib/utils";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import LockIcon from "@/public/assets/images/docs/lock.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import FolderIcon from "@/public/assets/images/mail/folder.svg";

function ShareOption({
  name,
  checked,
  disabled,
  icon,
  title,
  onSelect,
  children,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  icon: ReactNode;
  title: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "ease-power3-out flex items-start gap-3 rounded-xl p-3 transition-colors duration-150",
        disabled ? "cursor-default opacity-60" : "cursor-pointer",
        checked ? "bg-white/[0.05] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]" : !disabled && "hover:bg-white/[0.03]",
      )}
    >
      <span className="bg-secondary flex size-8 shrink-0 items-center justify-center rounded-lg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-foreground text-[13.5px] leading-5 font-medium">{title}</span>
        <span className="caption-style text-subtle">{children}</span>
      </span>
      <Radio name={name} checked={checked} disabled={disabled} onChange={onSelect} className="mt-2" aria-label={title} />
    </label>
  );
}

function ShareButton({ shared, compact, className, ...props }: { shared: boolean; compact?: boolean; className?: string } & ComponentProps<"button">) {
  const Icon = shared ? UsersIcon : LockIcon;
  return (
    <Button
      variant="secondary"
      size={compact ? "icon" : "sm"}
      aria-label={shared ? "Shared with workspace. Change sharing" : "Private. Change sharing"}
      className={cn("data-[state=open]:bg-muted", !compact && "h-[30px] px-3", className)}
      {...props}
    >
      <Icon aria-hidden className={cn("size-3.5", shared ? "text-(--tag-blue-text)" : "text-subtle")} />
      {!compact && (shared ? "Shared" : "Private")}
    </Button>
  );
}

function othersMoveText(count: number) {
  return `${count === 1 ? "1 item here belongs" : `${count} items here belong`} to other people. Making it private moves them to their owners' top level.`;
}

function origin() {
  return typeof window === "undefined" ? "" : window.location.origin;
}

function ShareNotice({ tone = "plain", icon, children }: { tone?: "plain" | "amber"; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className={cn("mx-4 mt-3 flex items-start gap-2.5 rounded-lg px-3 py-2.5", tone === "amber" ? "bg-(--tag-amber-bg)" : "bg-white/[0.03]")}>
      {icon}
      <div className="caption-style text-soft flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
    </div>
  );
}

function ShareFooter({ link }: { link: () => string }) {
  return (
    <div className="border-line-strong mt-4 flex items-center gap-2 border-t px-4 py-3">
      <span className="caption-style text-subtle flex-1">The assistant and your MCP agents follow the same rule.</span>
      <CopyButton text={link} label="Copy link" />
    </div>
  );
}

export const SHARE_POPOVER_CLASS = "w-[min(22.5rem,calc(100vw-2rem))] p-0";

export function useSharePlacement() {
  const narrow = useMedia("(max-width: 767px)");
  return narrow ? ({ side: "bottom", align: "end" } as const) : ({ side: "right", align: "start" } as const);
}

type FolderSharingCounts = { sharedOnTheirOwn: number; ownedByOthers: number };

const COUNT_FAILED = "Couldn't check who owns the notes here. Try again.";

function useFolderSharing(folderId: string, open: boolean, version: string) {
  const [state, setState] = useState<{ key: string; counts: FolderSharingCounts | null; error: string | null } | null>(null);
  const key = `${folderId}:${version}`;
  useEffect(() => {
    if (!open) return;
    let live = true;
    void folderSharingAction(folderId)
      .then((result) => {
        if (!live) return;
        if (result.error === undefined) setState({ key, counts: result.data, error: null });
        else setState({ key, counts: null, error: result.error || COUNT_FAILED });
      })
      .catch(() => {
        if (live) setState({ key, counts: null, error: COUNT_FAILED });
      });
    return () => {
      live = false;
    };
  }, [folderId, open, key]);
  return state?.key === key ? state : { counts: null, error: null };
}

export function FolderSharePanel({ folder, open }: { folder: Folder; open: boolean }) {
  const nav = useDocsNav();
  const viewerId = useDocsStore((state) => state.viewer?.id ?? nav?.viewer.id);
  const share = useDocsStore((state) => state.share);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const owned = folder.owner.id === viewerId;
  const inherited = folder.visibility === "private" && folder.shared;
  const { counts, error: countError } = useFolderSharing(folder.id, open && owned, `${folder.visibility}:${folder.noteCount}`);
  const sharedOnOwn = counts?.sharedOnTheirOwn ?? 0;
  const othersInside = folder.visibility === "shared" ? (counts?.ownedByOthers ?? 0) : 0;
  const othersUnknown = folder.visibility === "shared" && counts === null;
  const groupLabel = useId();
  const confirmButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);

  async function apply(visibility: Visibility) {
    setConfirming(false);
    setPending(true);
    setError(await share({ kind: "folder", id: folder.id }, visibility));
    setPending(false);
  }

  function choose(visibility: Visibility) {
    if (visibility === folder.visibility || pending) return;
    if (visibility === "private" && (othersInside > 0 || othersUnknown)) return setConfirming(true);
    void apply(visibility);
  }

  return (
    <>
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <FolderIcon aria-hidden className="text-subtle size-3.5" />
        <h3 className="min-w-0 flex-1 truncate leading-5">Share {folder.name}</h3>
        <span className="caption-style text-subtle shrink-0">
          {folder.noteCount} {folder.noteCount === 1 ? "note" : "notes"}
        </span>
      </div>
      {owned ? (
        <div role="radiogroup" aria-labelledby={groupLabel} className="flex flex-col gap-1 px-2">
          <span id={groupLabel} className="sr-only">
            Who can see {folder.name}
          </span>
          <ShareOption name={`share-${folder.id}`} checked={!folder.shared} disabled={inherited || pending} onSelect={() => choose("private")} icon={<LockIcon aria-hidden className="text-soft size-3.5" />} title="Private">
            {inherited ? "Shared because it's inside a shared folder." : "Only you can see its notes."}
          </ShareOption>
          <ShareOption name={`share-${folder.id}`} checked={folder.shared} disabled={pending} onSelect={() => choose("shared")} icon={<UsersIcon aria-hidden className="size-3.5 text-(--tag-blue-text)" />} title="Shared with workspace">
            Everyone in the workspace can read and edit its notes.
          </ShareOption>
        </div>
      ) : (
        <ShareNotice icon={<ParticipantAvatar participant={folder.owner} size="xs" className="mt-px" />}>
          <p>
            Shared by {folder.owner.name}. Only {folder.owner.short} can make it private.
          </p>
        </ShareNotice>
      )}
      {owned && !confirming && (othersInside > 0 || sharedOnOwn > 0) && (
        <ShareNotice tone={othersInside > 0 ? "amber" : "plain"}>
          {othersInside > 0 && <p>{othersMoveText(othersInside)}</p>}
          {sharedOnOwn > 0 && <p>{sharedOnOwn === 1 ? "1 note here is shared on its own and stays shared." : `${sharedOnOwn} notes here are shared on their own and stay shared.`}</p>}
        </ShareNotice>
      )}
      {owned && confirming && (
        <ShareNotice tone="amber">
          <p role="alert">{othersInside > 0 ? othersMoveText(othersInside) : "Anything here that belongs to other people moves to their owners' top level."}</p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button ref={confirmButton} variant="primary" size="sm" disabled={pending} onClick={() => void apply("private")}>
              Make private
            </Button>
          </div>
        </ShareNotice>
      )}
      {(error ?? countError) && (
        <p role="alert" className="caption-style text-danger px-4 pt-3">
          {error ?? countError}
        </p>
      )}
      <ShareFooter link={() => `${origin()}${listHref({ kind: "folder", folderId: folder.id })}`} />
    </>
  );
}

export function FolderShare({ folder, compact = true }: { folder: Folder; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const placement = useSharePlacement();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ShareButton shared={folder.shared} compact={compact} />
      </PopoverTrigger>
      <PopoverContent {...placement} sideOffset={10} className={SHARE_POPOVER_CLASS}>
        <FolderSharePanel folder={folder} open={open} />
      </PopoverContent>
    </Popover>
  );
}

export function PageShare({ summary, compact = false }: { summary: PageSummary; compact?: boolean }) {
  const nav = useDocsNav();
  const share = useDocsStore((state) => state.share);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const viewerId = useDocsStore((state) => state.viewer?.id ?? nav?.viewer.id);
  const groupLabel = useId();
  const folder = summary.folderId ? nav?.folders.find((item) => item.id === summary.folderId) : undefined;
  const fromFolder = Boolean(folder?.shared);
  const owned = summary.owner.id === viewerId;
  const lockedShared = summary.visibility === "shared" && !owned;

  async function choose(visibility: Visibility) {
    if (visibility === summary.visibility || pending) return;
    setPending(true);
    setError(await share({ kind: "page", id: summary.id }, visibility));
    setPending(false);
  }

  if (summary.kind === "daily") {
    return (
      <span className="caption-style text-subtle flex shrink-0 items-center gap-1 px-1.5">
        <LockIcon aria-hidden className="size-3" />
        Only you
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <ShareButton shared={summary.shared} compact={compact} />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className={SHARE_POPOVER_CLASS}>
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
          <DocIcon aria-hidden className="text-subtle size-3.5" />
          <h3 className="min-w-0 flex-1 truncate leading-5">Share {summary.title || "Untitled"}</h3>
        </div>
        <div role="radiogroup" aria-labelledby={groupLabel} className="flex flex-col gap-1 px-2">
          <span id={groupLabel} className="sr-only">
            Who can see {summary.title || "Untitled"}
          </span>
          <ShareOption name={`share-${summary.id}`} checked={!summary.shared} disabled={fromFolder || lockedShared || pending} onSelect={() => void choose("private")} icon={<LockIcon aria-hidden className="text-soft size-3.5" />} title="Private">
            {owned ? "Only you." : `Only ${summary.owner.short}.`}
          </ShareOption>
          <ShareOption name={`share-${summary.id}`} checked={summary.shared} disabled={fromFolder || pending} onSelect={() => void choose("shared")} icon={<UsersIcon aria-hidden className="size-3.5 text-(--tag-blue-text)" />} title="Shared with workspace">
            Everyone in the workspace can read and edit it.
          </ShareOption>
        </div>
        {lockedShared && !fromFolder && (
          <ShareNotice icon={<ParticipantAvatar participant={summary.owner} size="xs" className="mt-px" />}>
            <p>{summary.owner.kind === "person" ? `Only ${summary.owner.short} can make it private.` : `${summary.owner.name} made it, so it stays shared.`}</p>
          </ShareNotice>
        )}
        {fromFolder && folder && (
          <ShareNotice>
            <p>
              Shared because it&apos;s in <span className="text-foreground">{folder.name}</span>. Move it out to make it private.
            </p>
          </ShareNotice>
        )}
        {error && (
          <p role="alert" className="caption-style text-danger px-4 pt-3">
            {error}
          </p>
        )}
        <ShareFooter link={() => `${origin()}${pageHref(summary.id)}`} />
      </PopoverContent>
    </Popover>
  );
}
