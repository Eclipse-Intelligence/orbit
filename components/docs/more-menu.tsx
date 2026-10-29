"use client";

import { useState, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import Switch from "@/components/_ui/switch";
import CopyButton from "@/components/_ui/copy-button";
import { canPlaceAtTop, placeableFolders } from "@/components/docs/docs-manage";
import { useDocsNav } from "@/components/docs/use-docs";
import type { Page } from "@/lib/docs/client-types";
import { pageHref } from "@/lib/docs/routes";
import { useDocsStore } from "@/stores/docs-store";
import { cn } from "@/lib/utils";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import MoreIcon from "@/public/assets/images/_common/more.svg";
import FolderIcon from "@/public/assets/images/mail/folder.svg";

function Row({ children, onClick, className, trailing }: { children: ReactNode; onClick: () => void; className?: string; trailing?: ReactNode }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "ui-style text-soft hover:text-foreground focus-visible:bg-white/6 flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors duration-150 outline-none hover:bg-white/5",
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {trailing}
      </button>
    </li>
  );
}

export default function MoreMenu({
  page,
  phone,
  onRename,
  onToggleRail,
  onHistory,
  onFocus,
  onArchived,
}: {
  page: Page;
  phone: boolean;
  onRename: () => void;
  onToggleRail: () => void;
  onHistory: () => void;
  onFocus: () => void;
  onArchived: () => void;
}) {
  const nav = useDocsNav();
  const move = useDocsStore((state) => state.move);
  const archive = useDocsStore((state) => state.archive);
  const setAssistantCanEdit = useDocsStore((state) => state.setAssistantCanEdit);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "move">("menu");
  const viewerId = useDocsStore((state) => state.viewer?.id ?? nav?.viewer.id);
  const note = page.kind === "note";
  const owned = page.owner.id === viewerId;
  const placement = { ownerId: page.owner.id, ownShared: page.visibility === "shared", viewerId };
  const destinations = [
    ...(canPlaceAtTop(placement) || page.folderId === null ? [{ id: null as string | null, name: "No folder" }] : []),
    ...placeableFolders(nav?.folders ?? [], placement).map((folder) => ({ id: folder.id as string | null, name: folder.name })),
  ];

  function close(then?: () => void) {
    setOpen(false);
    if (then) window.setTimeout(then, 60);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView("menu");
      }}
    >
      <PopoverTrigger asChild>
        <Button variant={phone ? "secondary" : "ghost"} size="icon" aria-label="More" title="More" className="data-[state=open]:bg-white/[0.07]">
          <MoreIcon aria-hidden className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(18.5rem,calc(100vw-2rem))] p-1.5">
        {view === "move" ? (
          <div className="flex flex-col">
            <div className="flex h-9 items-center gap-1 px-1">
              <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={() => setView("menu")}>
                <ChevronLeftIcon aria-hidden className="size-3" />
              </Button>
              <h3 className="ui-style text-subtle">Move to</h3>
            </div>
            <ul aria-label="Folders" className="flex max-h-72 flex-col overflow-y-auto">
              {destinations.map((folder) => (
                <Row
                  key={folder.id ?? "none"}
                  onClick={() => close(() => void move(page.id, folder.id))}
                  trailing={page.folderId === folder.id ? <>
                        <CheckIcon aria-hidden className="text-foreground size-3.5" />
                        <span className="sr-only">Current folder</span>
                      </> : null}
                >
                  <span className="flex items-center gap-2">
                    <FolderIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
                    {folder.name}
                  </span>
                </Row>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex flex-col">
            <ul className="flex flex-col">
              {note && (
                <Row onClick={() => setView("move")} trailing={<ChevronRightIcon aria-hidden className="text-faint size-3" />}>
                  Move to…
                </Row>
              )}
              {note && <Row onClick={() => close(onRename)}>Rename</Row>}
              <li>
                <CopyButton variant="ghost" label="Copy link" copiedLabel="Link copied" text={() => `${window.location.origin}${pageHref(page.id)}`} className="ui-style text-soft h-9 w-full justify-start gap-2.5 rounded-lg px-2.5 font-normal" />
              </li>
              {phone && <Row onClick={() => close(onToggleRail)}>Backlinks and details</Row>}
              {phone && <Row onClick={() => close(onHistory)}>Version history</Row>}
              {phone && <Row onClick={() => close(onFocus)}>Focus mode</Row>}
            </ul>
            {owned && (
              <>
                <div className="bg-line-strong mx-1 my-1.5 h-px" />
                <label className="flex cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="ui-style text-soft">Let the assistant edit without asking</span>
                    <span className="caption-style text-subtle">Its edits are saved as versions, so you can undo them.</span>
                  </span>
                  <Switch checked={page.assistantCanEdit} onChange={(value) => void setAssistantCanEdit(page.id, value)} label="Let the assistant edit without asking" />
                </label>
              </>
            )}
            {note && (
              <>
                <div className="bg-line-strong mx-1 my-1.5 h-px" />
                <div className="p-1">
                  <HoldButton size="sm" className="w-full" holding="Keep holding to archive" onConfirm={() => close(() => void archive(page.id).then(onArchived))}>
                    Hold to archive
                  </HoldButton>
                </div>
              </>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
