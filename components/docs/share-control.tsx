"use client";

import { useState, type ComponentProps, type ReactNode } from "react";
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

export function ShareButton({ shared, compact, className, ...props }: { shared: boolean; compact?: boolean; className?: string } & ComponentProps<"button">) {
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

function origin() {
  return typeof window === "undefined" ? "" : window.location.origin;
}

export function FolderShare({ folder, compact = true, summaries }: { folder: Folder; compact?: boolean; summaries: PageSummary[] }) {
  const nav = useDocsNav();
  const viewerId = useDocsStore((state) => state.viewer?.id ?? nav?.viewer.id);
  const share = useDocsStore((state) => state.share);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const owned = folder.owner.id === viewerId;
  const inherited = folder.visibility === "private" && folder.shared;
  const sharedOnOwn = summaries.filter((summary) => summary.folderId === folder.id && summary.visibility === "shared");

  async function choose(visibility: Visibility) {
    if (visibility === folder.visibility || pending) return;
    setPending(true);
    setError(await share({ kind: "folder", id: folder.id }, visibility));
    setPending(false);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <ShareButton shared={folder.shared} compact={compact} />
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" sideOffset={8} className="w-[min(22.5rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
          <FolderIcon aria-hidden className="text-subtle size-3.5" />
          <h3 className="min-w-0 flex-1 truncate leading-5">Share {folder.name}</h3>
          <span className="caption-style text-subtle shrink-0">
            {folder.noteCount} {folder.noteCount === 1 ? "note" : "notes"}
          </span>
        </div>
        {owned ? (
          <div className="flex flex-col gap-1 px-2">
            <ShareOption name={`share-${folder.id}`} checked={!folder.shared} disabled={inherited || pending} onSelect={() => void choose("private")} icon={<LockIcon aria-hidden className="text-soft size-3.5" />} title="Private">
              {inherited ? "It's inside a shared folder, so it's shared too." : "Only you can see these notes."}
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
        {owned && sharedOnOwn.length > 0 && !folder.shared && (
          <div className="mx-4 mt-3 flex items-start gap-2.5 rounded-lg bg-white/[0.03] px-3 py-2.5">
            <UsersIcon aria-hidden className="mt-px size-3.5 shrink-0 text-(--tag-blue-text)/80" />
            <p className="caption-style text-soft">
              <span className="text-foreground">{sharedOnOwn[0].title || "Untitled"}</span>
              {sharedOnOwn.length > 1 ? ` and ${sharedOnOwn.length - 1} more are` : " is"} already shared on {sharedOnOwn.length > 1 ? "their" : "its"} own. {sharedOnOwn.length > 1 ? "They stay" : "It stays"} shared either way.
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
  const folder = summary.folderId ? nav?.folders.find((item) => item.id === summary.folderId) : undefined;
  const fromFolder = Boolean(folder?.shared);

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
        <div className="flex flex-col gap-1 px-2">
          <ShareOption name={`share-${summary.id}`} checked={!summary.shared} disabled={fromFolder || pending} onSelect={() => void choose("private")} icon={<LockIcon aria-hidden className="text-soft size-3.5" />} title="Private">
            Only you can see this note.
          </ShareOption>
          <ShareOption name={`share-${summary.id}`} checked={summary.shared} disabled={fromFolder || pending} onSelect={() => void choose("shared")} icon={<UsersIcon aria-hidden className="size-3.5 text-(--tag-blue-text)" />} title="Shared with workspace">
            Everyone in the workspace can find, read and edit it.
          </ShareOption>
        </div>
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
