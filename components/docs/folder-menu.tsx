"use client";

import { useRef, useState, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import { Input } from "@/components/_ui/input";
import { useDocsNavigate } from "@/components/docs/use-docs";
import { listHref } from "@/lib/docs/routes";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import { archiveFolder, canPlaceAtTop, descendantsOf, placeableFolders } from "@/components/docs/docs-manage";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/_ui/popover";
import { FolderSharePanel, SHARE_POPOVER_CLASS } from "@/components/docs/share-control";
import type { Folder } from "@/lib/docs/client-types";
import { useDocsStore } from "@/stores/docs-store";
import { cn } from "@/lib/utils";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import MoreIcon from "@/public/assets/images/_common/more.svg";
import FolderIcon from "@/public/assets/images/mail/folder.svg";

export default function FolderMenu({
  folder,
  folders,
  viewerId,
  open,
  onOpenChange,
  onNewNote,
  onNewFolder,
  onRename,
  onArchived,
  className,
  phone = false,
}: {
  folder: Folder;
  folders: Folder[];
  viewerId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNewNote: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onArchived: () => void;
  className?: string;
  phone?: boolean;
}) {
  const moveFolder = useDocsStore((state) => state.moveFolder);
  const [view, setView] = useState<"menu" | "move">("menu");
  const [archiving, setArchiving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const shareNext = useRef(false);
  const owned = folder.owner.id === viewerId;
  const ownShared = folder.visibility === "shared";
  const placement = { ownerId: folder.owner.id, ownShared, viewerId, exclude: descendantsOf(folders, folder.id) };
  const targets = placeableFolders(folders, placement);
  const atTop = canPlaceAtTop(placement);
  const siblingsOf = (parentId: string | null) => folders.filter((item) => item.parentId === parentId && item.id !== folder.id).length;

  function later(action: () => void) {
    window.setTimeout(action, 0);
  }

  return (
    <Popover open={sharing} onOpenChange={setSharing}>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next);
          if (!next) setView("menu");
        }}
      >
        <PopoverAnchor asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant={phone ? "secondary" : "ghost"}
              size={phone ? "icon" : "icon-sm"}
              tabIndex={phone ? undefined : -1}
              aria-label={`${folder.name} options`}
              title="Folder options"
              className={cn(!phone && "size-5 rounded-md", className)}
            >
              <MoreIcon aria-hidden className={phone ? "size-3.5" : "size-3"} />
            </Button>
          </DropdownMenuTrigger>
        </PopoverAnchor>
        <DropdownMenuContent
          align={phone ? "end" : "start"}
          className="w-56"
          onCloseAutoFocus={(event) => {
            if (!shareNext.current) return;
            shareNext.current = false;
            event.preventDefault();
            setSharing(true);
          }}
        >
          {view === "move" ? (
            <>
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setView("menu");
                }}
              >
                <ChevronLeftIcon aria-hidden className="text-subtle size-3" />
                Move {folder.name} to
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {atTop && (
                <DropdownMenuItem disabled={folder.parentId === null} onSelect={() => void moveFolder(folder.id, null, siblingsOf(null))}>
                  <FolderIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">Top level</span>
                  {folder.parentId === null && <CheckIcon aria-label="Current place" role="img" className="size-3.5" />}
                </DropdownMenuItem>
              )}
              {targets.map((target) => (
                <DropdownMenuItem key={target.id} disabled={folder.parentId === target.id} onSelect={() => void moveFolder(folder.id, target.id, siblingsOf(target.id))}>
                  <FolderIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{target.name}</span>
                  {folder.parentId === target.id && <CheckIcon aria-label="Current place" role="img" className="size-3.5" />}
                </DropdownMenuItem>
              ))}
              {!atTop && targets.length === 0 && <DropdownMenuLabel>No other folders</DropdownMenuLabel>}
            </>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => later(onNewNote)}>New note</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => later(onNewFolder)}>New folder</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => later(onRename)}>Rename</DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setView("move");
                }}
              >
                <span className="flex-1">Move to</span>
                <ChevronRightIcon aria-hidden className="text-subtle size-3" />
              </DropdownMenuItem>
              {owned && <DropdownMenuItem onSelect={() => (shareNext.current = true)}>Share</DropdownMenuItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-danger" onSelect={() => later(() => setArchiving(true))}>
                Archive
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <PopoverContent align={phone ? "end" : "start"} side={phone ? "bottom" : "right"} sideOffset={10} className={SHARE_POPOVER_CLASS}>
        <FolderSharePanel folder={folder} open={sharing} />
      </PopoverContent>
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title={`Archive ${folder.name}?`}
        description="Archives every note and folder inside it, for everyone. Restore it from Archived."
        confirmLabel="Archive"
        onConfirm={() =>
          void archiveFolder(folder).then((done) => {
            if (done) onArchived();
          })
        }
      />
    </Popover>
  );
}

function NameDialog({ open, title, label, initial, confirmLabel, onOpenChange, onSubmit }: { open: boolean; title: string; label: string; initial: string; confirmLabel: string; onOpenChange: (open: boolean) => void; onSubmit: (name: string) => Promise<string | null> }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (!name) return setError("Give the folder a name.");
    setPending(true);
    const problem = await onSubmit(name);
    setPending(false);
    if (problem) setError(problem);
    else onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <DialogHeader className="pr-12">
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <label className="flex flex-col gap-1.5 px-6">
            <span className="caption-style text-soft">{label}</span>
            <Input name="name" defaultValue={initial} maxLength={120} autoFocus autoComplete="off" />
            {error && (
              <span role="alert" className="caption-style text-danger">
                {error}
              </span>
            )}
          </label>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="md">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" size="md" disabled={pending}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PhoneFolderMenu({ folder, folders, viewerId, onNewNote }: { folder: Folder; folders: Folder[]; viewerId: string | undefined; onNewNote: () => void }) {
  const navigate = useDocsNavigate();
  const createFolder = useDocsStore((state) => state.createFolder);
  const renameFolder = useDocsStore((state) => state.renameFolder);
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<"new" | "rename" | null>(null);
  return (
    <>
      <FolderMenu
        phone
        folder={folder}
        folders={folders}
        viewerId={viewerId}
        open={open}
        onOpenChange={setOpen}
        onNewNote={onNewNote}
        onNewFolder={() => setNaming("new")}
        onRename={() => setNaming("rename")}
        onArchived={() => navigate("/docs")}
      />
      <NameDialog
        key={naming ?? "closed"}
        open={naming !== null}
        onOpenChange={(next) => !next && setNaming(null)}
        title={naming === "rename" ? `Rename ${folder.name}` : `New folder in ${folder.name}`}
        label="Folder name"
        initial={naming === "rename" ? folder.name : ""}
        confirmLabel={naming === "rename" ? "Rename" : "Create"}
        onSubmit={async (name) => {
          if (naming === "rename") return renameFolder(folder.id, name);
          const created = await createFolder(name, folder.id);
          if (!created) return "The folder wasn't created. Try again.";
          navigate(listHref({ kind: "folder", folderId: created.id }));
          return null;
        }}
      />
    </>
  );
}
