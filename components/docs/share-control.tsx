"use client";

import { useEffect, useId, useState, type ComponentProps, type ReactNode } from "react";
import { folderSharingAction } from "@/app/(crm)/docs/manage-actions";
import Button from "@/components/_ui/button";
import CopyButton from "@/components/_ui/copy-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { Radio } from "@/components/_ui/radio";
import { ParticipantAvatar } from "@/components/docs/presence";
import { useDocsNav } from "@/components/docs/use-docs";
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
      title={shared ? "Shared with everyone in the workspace" : "Only you can see this"}
      className={cn("data-[state=open]:bg-muted", !compact && "h-[30px] px-3", className)}
      {...props}
    >
      <Icon aria-hidden className={cn("size-3.5", shared ? "text-(--tag-blue-text)" : "text-subtle")} />
      {!compact && (shared ? "Shared" : "Private")}
    </Button>
  );
}

export function othersMoveText(count: number) {
  return `${count === 1 ? "1 note or folder in here belongs" : `${count} notes or folders in here belong`} to other people. Making it private moves them to the top level of their owners' Docs.`;
}

function origin() {
  return typeof window === "undefined" ? "" : window.location.origin;
}

type FolderSharingCounts = { sharedOnTheirOwn: number; ownedByOthers: number };

export function useFolderSharing(folderId: string, open: boolean, version: string) {
  const [state, setState] = useState<{ key: string; counts: FolderSharingCounts } | null>(null);
  const key = `${folderId}:${version}`;
  useEffect(() => {
    if (!open) return;
    let live = true;
    void folderSharingAction(folderId)
      .then((result) => {
        if (live && result.error === undefined) setState({ key, counts: result.data });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [folderId, open, key]);
  return state?.key === key ? state.counts : null;
}

export function FolderShare({ folder, compact = true }: { folder: Folder; compact?: boolean }) {
  const nav = useDocsNav();
  const viewerId = useDocsStore((state) => state.viewer?.id ?? nav?.viewer.id);
  const share = useDocsStore((state) => state.share);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const owned = folder.owner.id === viewerId;
  const inherited = folder.visibility === "private" && folder.shared;
  const counts = useFolderSharing(folder.id, open && owned, `${folder.visibility}:${folder.noteCount}`);
  const sharedOnOwn = counts?.sharedOnTheirOwn ?? null;
  const othersInside = folder.visibility === "shared" ? (counts?.ownedByOthers ?? 0) : 0;
  const groupLabel = useId();

  async function choose(visibility: Visibility) {
    if (visibility === folder.visibility || pending) return;
    setPending(true);
    setError(await share({ kind: "folder", id: folder.id }, visibility));
    setPending(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ShareButton shared={folder.shared} compact={compact} />
      </PopoverTrigger>
      <PopoverContent align="start" side="right" sideOffset={10} className="w-[min(22.5rem,calc(100vw-2rem))] p-0">
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
            <ShareOption name={`share-${folder.id}`} checked={!folder.shared} disabled={inherited || pending} onSelect={() => void choose("private")} icon={<LockIcon aria-hidden className="text-soft size-3.5" />} title="Private">
              {inherited ? "It's inside a shared folder, so it's shared too." : "Only you can see them, apart from notes shared on their own."}
            </ShareOption>
            <ShareOption name={`share-${folder.id}`} checked={folder.shared} disabled={pending} onSelect={() => void choose("shared")} icon={<UsersIcon aria-hidden className="size-3.5 text-(--tag-blue-text)" />} title="Shared with workspace">
              Everyone in the workspace can find, read and edit them, including notes you add later.
            </ShareOption>
          </div>
        ) : (
          <div className="mx-4 flex items-start gap-2.5 rounded-lg bg-white/[0.03] px-3 py-2.5">
            <ParticipantAvatar participant={folder.owner} size="xs" className="mt-px" />
            <p className="caption-style text-soft">
              {folder.owner.name} shared this folder. Everyone in the workspace can read and edit it. Only {folder.owner.short} can make it private.
            </p>
          </div>
        )}
        {owned && othersInside > 0 && (
          <div className="mx-4 mt-3 flex items-start gap-2.5 rounded-lg bg-(--tag-amber-bg) px-3 py-2.5">
            <p className="caption-style text-soft">{othersMoveText(othersInside)}</p>
          </div>
        )}
        {owned && sharedOnOwn !== null && sharedOnOwn > 0 && (
          <div className="mx-4 mt-3 flex items-start gap-2.5 rounded-lg bg-white/[0.03] px-3 py-2.5">
            <UsersIcon aria-hidden className="mt-px size-3.5 shrink-0 text-(--tag-blue-text)/80" />
            <p className="caption-style text-soft">
              {sharedOnOwn === 1 ? "1 note in here is" : `${sharedOnOwn} notes in here are`} shared on {sharedOnOwn === 1 ? "its" : "their"} own, so {sharedOnOwn === 1 ? "it stays" : "they stay"} shared either way.
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="caption-style text-danger px-4 pt-3">
            {error}
          </p>
        )}
        <div className="border-line-strong mt-4 flex items-center gap-2 border-t px-4 py-3">
          <span className="caption-style text-subtle flex-1">The assistant and your MCP agents follow the same rule.</span>
          <CopyButton text={() => `${origin()}${listHref({ kind: "folder", folderId: folder.id })}`} label="Copy link" />
        </div>
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
      <span className="caption-style text-subtle flex shrink-0 items-center gap-1 px-1.5" title="Daily notes are always private">
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
      <PopoverContent align="end" sideOffset={8} className="w-[min(22.5rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
          <DocIcon aria-hidden className="text-subtle size-3.5" />
          <h3 className="min-w-0 flex-1 truncate leading-5">Share {summary.title || "Untitled"}</h3>
        </div>
        <div role="radiogroup" aria-labelledby={groupLabel} className="flex flex-col gap-1 px-2">
          <span id={groupLabel} className="sr-only">
            Who can see {summary.title || "Untitled"}
          </span>
          <ShareOption name={`share-${summary.id}`} checked={!summary.shared} disabled={fromFolder || lockedShared || pending} onSelect={() => void choose("private")} icon={<LockIcon aria-hidden className="text-soft size-3.5" />} title="Private">
            {owned ? "Only you can see this note." : `Only ${summary.owner.short} would see this note.`}
          </ShareOption>
          <ShareOption name={`share-${summary.id}`} checked={summary.shared} disabled={fromFolder || pending} onSelect={() => void choose("shared")} icon={<UsersIcon aria-hidden className="size-3.5 text-(--tag-blue-text)" />} title="Shared with workspace">
            Everyone in the workspace can find, read and edit it.
          </ShareOption>
        </div>
        {lockedShared && !fromFolder && (
          <div className="mx-4 mt-3 flex items-start gap-2.5 rounded-lg bg-white/[0.03] px-3 py-2.5">
            <ParticipantAvatar participant={summary.owner} size="xs" className="mt-px" />
            <p className="caption-style text-soft">{summary.owner.kind === "person" ? `Only ${summary.owner.short} can make it private.` : `${summary.owner.name} made it, so it stays shared.`}</p>
          </div>
        )}
        {fromFolder && folder && (
          <div className="mx-4 mt-3 flex items-start gap-2.5 rounded-lg bg-white/[0.03] px-3 py-2.5">
            <UsersIcon aria-hidden className="mt-px size-3.5 shrink-0 text-(--tag-blue-text)/80" />
            <p className="caption-style text-soft">
              It&apos;s in <span className="text-foreground">{folder.name}</span>, which is shared. Move it to a private folder to make it private.
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="caption-style text-danger px-4 pt-3">
            {error}
          </p>
        )}
        <div className="border-line-strong mt-4 flex items-center gap-2 border-t px-4 py-3">
          <span className="caption-style text-subtle flex-1">The assistant and your MCP agents follow the same rule.</span>
          <CopyButton text={() => `${origin()}${pageHref(summary.id)}`} label="Copy link" />
        </div>
      </PopoverContent>
    </Popover>
  );
}
