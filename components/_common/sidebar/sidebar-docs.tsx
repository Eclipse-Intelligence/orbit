"use client";

import { useEffect, useId, useRef, useState, type ComponentType, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type SVGProps } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import Button from "@/components/_ui/button";
import { ARCHIVED_HREF } from "@/components/docs/docs-manage";
import FolderMenu from "@/components/docs/folder-menu";
import { ParticipantAvatar } from "@/components/docs/presence";
import { NOTE_TYPE, navigateWithinDocs, useDocsNav, useDocsNavigate } from "@/components/docs/use-docs";
import type { Folder, TagNode } from "@/lib/docs/client-types";
import { listHref, pageHref, parseDocsRoute } from "@/lib/docs/routes";
import { useCompaniesStore } from "@/stores/companies-store";
import { useDocsStore } from "@/stores/docs-store";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import HashIcon from "@/public/assets/images/docs/hash.svg";
import SunIcon from "@/public/assets/images/docs/sun.svg";
import ArchiveIcon from "@/public/assets/images/mail/archive.svg";
import FolderIcon from "@/public/assets/images/mail/folder.svg";

const OPEN_KEY = "orbit-docs-tree";
const FOLDER_TYPE = "application/x-orbit-folder";

type Drop = { id: string; place: "before" | "inside" | "after" } | null;

function readOpen() {
  try {
    const parsed = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "null");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function visibleItems(root: HTMLElement | null) {
  return [...(root?.querySelectorAll<HTMLElement>("[data-tree-item]") ?? [])].filter((item) => item.getClientRects().length > 0);
}

function TreeItem({
  icon: Icon,
  label,
  href,
  level,
  active,
  open,
  onToggle,
  trailing,
  tabbable,
  drag,
  onKeyDown,
  onDoubleClick,
  onContextMenu,
  className,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: ReactNode;
  href: string;
  level: number;
  active: boolean;
  open?: boolean;
  onToggle?: () => void;
  trailing?: ReactNode;
  tabbable: boolean;
  drag?: { draggable: boolean; onDragStart: (event: DragEvent<HTMLAnchorElement>) => void; onDragOver: (event: DragEvent<HTMLAnchorElement>) => void; onDragLeave: () => void; onDrop: (event: DragEvent<HTMLAnchorElement>) => void; indicator: "before" | "inside" | "after" | null };
  onKeyDown?: (event: KeyboardEvent<HTMLAnchorElement>) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
}) {
  const setSidebarOpen = useCompaniesStore((state) => state.setSidebarOpen);
  return (
    <Link
      href={href}
      role="treeitem"
      aria-level={level}
      aria-expanded={open}
      aria-current={active ? "page" : undefined}
      aria-selected={active}
      data-tree-item=""
      data-active={active}
      tabIndex={tabbable ? 0 : -1}
      draggable={drag?.draggable}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDragLeave={drag?.onDragLeave}
      onDrop={drag?.onDrop}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "ArrowRight" && onToggle && !open) {
          event.preventDefault();
          onToggle();
        }
        if (event.key === "ArrowLeft" && onToggle && open) {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }
      }}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        setSidebarOpen(false);
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (navigateWithinDocs(href)) event.preventDefault();
      }}
      className={cn(
        "group text-sidebar-foreground hover:text-foreground focus-visible:ring-ring/60 relative flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-[13.5px] leading-none outline-none focus-visible:ring-2",
        "data-[active=true]:bg-sidebar-primary data-[active=true]:text-foreground data-[active=true]:shadow-[0px_0px_0px_1px_rgba(0,0,0,0.4),inset_0px_1px_0px_0px_rgba(255,255,255,0.1),inset_0px_0px_0px_1px_rgba(255,255,255,0.06)]",
        drag?.indicator === "inside" && "bg-white/[0.06] shadow-[inset_0_0_0_1px_var(--primary)]",
        className,
      )}
      style={{ paddingLeft: `${0.5 + (level - 1) * 0.875}rem` }}
    >
      {drag?.indicator === "before" && <span aria-hidden className="bg-primary absolute inset-x-1 -top-px h-0.5 rounded-full" />}
      {drag?.indicator === "after" && <span aria-hidden className="bg-primary absolute inset-x-1 -bottom-px h-0.5 rounded-full" />}
      <Icon aria-hidden className="text-subtle group-hover:text-icon group-data-[active=true]:text-icon ease-power3-out size-3.5 shrink-0 transition-colors duration-150" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {onToggle && (
        <span
          role="presentation"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggle();
          }}
          className="text-faint hover:text-foreground -mr-1 flex size-5 shrink-0 items-center justify-center rounded-md"
        >
          <ChevronDownIcon aria-hidden className={cn("ease-power3-out size-3 transition-transform duration-150", !open && "-rotate-90")} />
        </span>
      )}
      {trailing}
    </Link>
  );
}

function FolderMark({ folder, viewerId }: { folder: Folder; viewerId: string | undefined }) {
  if (!folder.shared) return null;
  if (folder.owner.id !== viewerId) {
    return (
      <span className="flex shrink-0 items-center" title={`Shared by ${folder.owner.name}`}>
        <ParticipantAvatar participant={folder.owner} size="xs" />
        <span className="sr-only">, shared by {folder.owner.name}</span>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center" title="Shared with workspace">
      <UsersIcon aria-hidden className="text-faint size-3.5" />
      <span className="sr-only">, shared with workspace</span>
    </span>
  );
}

function ancestorKeys(folders: Folder[], id: string | null) {
  const keys: string[] = [];
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  let parent = id ? (byId.get(id)?.parentId ?? null) : null;
  while (parent && byId.has(parent) && keys.length < 32) {
    keys.push(`folder:${parent}`);
    parent = byId.get(parent)?.parentId ?? null;
  }
  return keys;
}

function tagAncestorKeys(path: string | null) {
  if (!path) return [];
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => `tag:${parts.slice(0, index + 1).join("/")}`);
}

function hasTag(tags: TagNode[], path: string): boolean {
  return tags.some((tag) => tag.path === path || hasTag(tag.children, path));
}

function NameInput({ label, defaultValue, placeholder, onDone, level }: { label: string; defaultValue?: string; placeholder?: string; onDone: (value: string | null) => void; level: number }) {
  const cancelled = useRef(false);
  return (
    <input
      autoFocus
      defaultValue={defaultValue}
      aria-label={label}
      placeholder={placeholder}
      maxLength={120}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.stopPropagation();
          cancelled.current = true;
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => onDone(cancelled.current ? null : event.currentTarget.value)}
      style={{ marginLeft: `${(level - 1) * 0.875}rem`, width: `calc(100% - ${(level - 1) * 0.875}rem)` }}
      className="bg-sidebar-primary text-foreground placeholder:text-subtle focus-visible:ring-ring/60 h-7 rounded-lg px-2 text-[13.5px] outline-none focus-visible:ring-2"
    />
  );
}

export default function SidebarDocs() {
  const nav = useDocsNav();
  const pathname = usePathname();
  const params = useSearchParams();
  const navigate = useDocsNavigate();
  const setSidebarOpen = useCompaniesStore((state) => state.setSidebarOpen);
  const createNote = useDocsStore((state) => state.createNote);
  const createFolder = useDocsStore((state) => state.createFolder);
  const renameFolder = useDocsStore((state) => state.renameFolder);
  const moveFolder = useDocsStore((state) => state.moveFolder);
  const move = useDocsStore((state) => state.move);
  const [open, setOpen] = useState<Record<string, boolean> | null>(null);
  const [naming, setNaming] = useState<{ parentId: string | null } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop>(null);
  const tagsLabel = useId();
  const loading = useDocsStore((state) => state.nav === null);

  const onDocs = pathname === "/docs" || pathname.startsWith("/docs/");
  const route = onDocs ? parseDocsRoute(pathname, params) : null;
  const pageFolder = useDocsStore((state) => (route?.pageId ? (state.summaries[route.pageId]?.folderId ?? null) : null));
  const pageDaily = useDocsStore((state) => (route?.pageId ? state.summaries[route.pageId]?.kind === "daily" : false));

  useEffect(() => {
    const timer = window.setTimeout(() => setOpen(readOpen()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const folders = nav?.folders ?? EMPTY_FOLDERS;
  const activeFolder = route?.list.kind === "folder" ? route.list.folderId : route?.pageId && route.list.kind === "all" ? pageFolder : null;
  const activeTag = route?.list.kind === "tag" ? route.list.path : null;
  const reveal = [...ancestorKeys(folders, activeFolder), ...tagAncestorKeys(activeTag)];
  const revealKey = reveal.join("|");
  const [revealed, setRevealed] = useState("");
  if (open && revealKey && revealed !== revealKey) {
    setRevealed(revealKey);
    if (reveal.some((key) => open[key] === false)) setOpen({ ...open, ...Object.fromEntries(reveal.map((key) => [key, true])) });
  }

  if (!nav) return null;
  const dailyActive = route?.list.kind === "daily" || pageDaily;
  const allActive = Boolean(route && route.list.kind === "all" && !route.pageId && !dailyActive);
  const viewerId = nav.viewer.id;
  const known = new Set(folders.map((folder) => folder.id));
  const isOpen = (key: string, fallback: boolean) => open?.[key] ?? fallback;
  const toggle = (key: string, fallback: boolean) =>
    setOpen((current) => {
      const next = { ...current, [key]: !(current?.[key] ?? fallback) };
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });

  const children = (parentId: string | null) =>
    folders
      .filter((folder) => (parentId === null ? !folder.parentId || !known.has(folder.parentId) : folder.parentId === parentId))
      .sort((left, right) => left.position - right.position);
  const tabbableHref = activeFolder && known.has(activeFolder) ? listHref({ kind: "folder", folderId: activeFolder }) : "/docs/daily";
  const tabbableTag = activeTag && hasTag(nav.tags, activeTag) ? listHref({ kind: "tag", path: activeTag }) : nav.tags[0] ? listHref({ kind: "tag", path: nav.tags[0].path }) : null;

  function onTreeKey(event: KeyboardEvent<HTMLUListElement>) {
    const items = visibleItems(event.currentTarget);
    const index = items.findIndex((item) => item === document.activeElement);
    if (index < 0) return;
    let next = -1;
    if (event.key === "ArrowDown") next = Math.min(items.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowLeft") {
      const level = Number(items[index].getAttribute("aria-level"));
      for (let at = index - 1; at >= 0; at -= 1) {
        if (Number(items[at].getAttribute("aria-level")) < level) {
          next = at;
          break;
        }
      }
    } else if (event.key === "ArrowRight" && items[index].getAttribute("aria-expanded") === "true") next = Math.min(items.length - 1, index + 1);
    if (next < 0) return;
    event.preventDefault();
    items[next].focus();
  }

  function dragOver(folder: Folder) {
    return (event: DragEvent<HTMLAnchorElement>) => {
      const types = event.dataTransfer.types;
      if (!types.includes(FOLDER_TYPE) && !types.includes(NOTE_TYPE)) return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      const offset = (event.clientY - box.top) / box.height;
      const place = types.includes(NOTE_TYPE) ? "inside" : offset < 0.28 ? "before" : offset > 0.72 ? "after" : "inside";
      event.dataTransfer.dropEffect = "move";
      setDrop((current) => (current?.id === folder.id && current.place === place ? current : { id: folder.id, place }));
    };
  }

  function dropOn(folder: Folder) {
    return (event: DragEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      const place = drop?.id === folder.id ? drop.place : "inside";
      setDrop(null);
      const note = event.dataTransfer.getData(NOTE_TYPE);
      if (note) {
        void move(note, folder.id);
        return;
      }
      const dragged = event.dataTransfer.getData(FOLDER_TYPE);
      if (!dragged || dragged === folder.id) return;
      if (place === "inside") {
        void moveFolder(dragged, folder.id, children(folder.id).length);
        setOpen((current) => ({ ...current, [`folder:${folder.id}`]: true }));
        return;
      }
      const parentId = folder.parentId && known.has(folder.parentId) ? folder.parentId : null;
      const siblings = children(parentId).filter((item) => item.id !== dragged);
      const index = siblings.findIndex((item) => item.id === folder.id);
      void moveFolder(dragged, parentId, place === "before" ? index : index + 1);
    };
  }

  function folderKey(folder: Folder) {
    return (event: KeyboardEvent<HTMLAnchorElement>) => {
      if (event.key === "F2") {
        event.preventDefault();
        setRenaming(folder.id);
        return;
      }
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        setMenuFor(folder.id);
        return;
      }
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      event.stopPropagation();
      const parentId = folder.parentId && known.has(folder.parentId) ? folder.parentId : null;
      const siblings = children(parentId);
      const index = siblings.findIndex((item) => item.id === folder.id);
      const target = index + (event.key === "ArrowUp" ? -1 : 1);
      if (target < 0 || target >= siblings.length) return;
      void moveFolder(folder.id, parentId, target);
    };
  }

  async function finishRename(folder: Folder, value: string | null) {
    setRenaming(null);
    const name = value?.trim();
    if (!name || name === folder.name) return;
    const problem = await renameFolder(folder.id, name);
    if (problem) setError(problem);
  }

  async function finishCreate(parentId: string | null, value: string | null) {
    setNaming(null);
    const name = value?.trim();
    if (!name) return;
    const folder = await createFolder(name, parentId);
    if (folder) {
      setSidebarOpen(false);
      navigate(listHref({ kind: "folder", folderId: folder.id }));
    }
  }

  function startFolder(parentId: string | null) {
    setError(null);
    if (parentId) setOpen((current) => ({ ...current, [`folder:${parentId}`]: true }));
    setNaming({ parentId });
  }

  async function noteIn(folder: Folder) {
    const page = await createNote({ folderId: folder.id });
    if (!page) return;
    setSidebarOpen(false);
    navigate(pageHref(page.id, { kind: "folder", folderId: folder.id }));
  }

  function renderFolders(parentId: string | null, level: number): ReactNode {
    return children(parentId).map((folder) => {
      const nested = children(folder.id).length > 0;
      const key = `folder:${folder.id}`;
      const namingHere = naming?.parentId === folder.id;
      const expanded = nested || namingHere ? isOpen(key, true) || namingHere : undefined;
      const href = listHref({ kind: "folder", folderId: folder.id });
      const menuOpen = menuFor === folder.id;
      return (
        <li key={folder.id} role="none">
          {renaming === folder.id ? (
            <NameInput label="Folder name" defaultValue={folder.name} level={level} onDone={(value) => void finishRename(folder, value)} />
          ) : (
            <div className="group/folder relative">
              <TreeItem
                icon={FolderIcon}
                label={folder.name}
                href={href}
                level={level}
                active={activeFolder === folder.id}
                open={expanded}
                onToggle={nested ? () => toggle(key, true) : undefined}
                tabbable={tabbableHref === href}
                trailing={<FolderMark folder={folder} viewerId={viewerId} />}
                onKeyDown={folderKey(folder)}
                onDoubleClick={() => setRenaming(folder.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenuFor(folder.id);
                }}
                className={cn("max-md:pr-8 md:group-focus-within/folder:pr-7 md:group-hover/folder:pr-7", menuOpen && "md:pr-7")}
                drag={{
                  draggable: folder.owner.id === viewerId,
                  onDragStart: (event) => {
                    event.dataTransfer.setData(FOLDER_TYPE, folder.id);
                    event.dataTransfer.effectAllowed = "move";
                  },
                  onDragOver: dragOver(folder),
                  onDragLeave: () => setDrop((current) => (current?.id === folder.id ? null : current)),
                  onDrop: dropOn(folder),
                  indicator: drop?.id === folder.id ? drop.place : null,
                }}
              />
              <span
                className={cn(
                  "absolute inset-y-0 right-1 flex items-center md:opacity-0 md:group-focus-within/folder:opacity-100 md:group-hover/folder:opacity-100",
                  menuOpen && "md:opacity-100",
                )}
              >
                <FolderMenu
                  folder={folder}
                  folders={folders}
                  viewerId={viewerId}
                  open={menuOpen}
                  onOpenChange={(next) => setMenuFor(next ? folder.id : null)}
                  onNewNote={() => void noteIn(folder)}
                  onNewFolder={() => startFolder(folder.id)}
                  onRename={() => setRenaming(folder.id)}
                  onArchived={() => {
                    if (activeFolder === folder.id) navigate("/docs");
                  }}
                  className="data-[state=open]:bg-white/[0.07]"
                />
              </span>
            </div>
          )}
          {expanded && (
            <ul role="group" className="flex flex-col">
              {renderFolders(folder.id, level + 1)}
              {namingHere && (
                <li role="none">
                  <NameInput label={`New folder in ${folder.name}`} placeholder="Folder name" level={level + 1} onDone={(value) => void finishCreate(folder.id, value)} />
                </li>
              )}
            </ul>
          )}
        </li>
      );
    });
  }

  function renderTags(tags: TagNode[], level: number): ReactNode {
    return tags.map((tag) => {
      const key = `tag:${tag.path}`;
      const nested = tag.children.length > 0;
      const expanded = nested ? isOpen(key, level === 1) : undefined;
      const href = listHref({ kind: "tag", path: tag.path });
      return (
        <li key={tag.path} role="none">
          <TreeItem
            icon={HashIcon}
            label={
              <>
                {tag.name}
                <span className="sr-only">, {tag.count} notes</span>
              </>
            }
            href={href}
            level={level}
            active={activeTag === tag.path}
            open={expanded}
            onToggle={nested ? () => toggle(key, level === 1) : undefined}
            tabbable={tabbableTag === href}
          />
          {nested && expanded && (
            <ul role="group" className="flex flex-col">
              {renderTags(tag.children, level + 1)}
            </ul>
          )}
        </li>
      );
    });
  }

  return (
    <div className="border-sidebar-border flex flex-col gap-1 border-b p-3">
      <ul className="flex flex-col">
        <li className={cn("relative", allActive && "mb-0.75")}>
          <Button
            variant="nav"
            size="md"
            href="/docs"
            data-active={allActive}
            aria-current={allActive ? "page" : undefined}
            onClick={(event) => {
              setSidebarOpen(false);
              if (navigateWithinDocs("/docs")) event.preventDefault();
            }}
            className="group h-[30px] gap-1.5 py-0 data-[active=true]:h-8"
          >
            <DocIcon aria-hidden className="text-subtle ease-power3-out group-hover:text-icon group-data-[active=true]:text-icon size-3.5 shrink-0 transition-colors duration-150" />
            <span className="min-w-0 flex-1 truncate text-left">Docs</span>
            <span aria-hidden className="w-5 shrink-0" />
          </Button>
          <span className="absolute inset-y-0 right-1 flex items-center">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New note"
              title="New note (C then N)"
              className="size-5 rounded-md"
              onClick={() =>
                void createNote().then((page) => {
                  if (!page) return;
                  setSidebarOpen(false);
                  navigate(pageHref(page.id));
                })
              }
            >
              <PlusIcon aria-hidden className="size-3" />
            </Button>
          </span>
        </li>
      </ul>
      <ul role="tree" aria-label="Docs folders" aria-busy={loading || undefined} onKeyDown={onTreeKey} className="border-sidebar-border ml-[15px] flex flex-col border-l pl-1.5">
        <li role="none">
          <TreeItem
            icon={SunIcon}
            label="Daily notes"
            href="/docs/daily"
            level={1}
            active={dailyActive}
            tabbable={tabbableHref === "/docs/daily"}
            trailing={nav.dailyCount > 0 ? <span className="caption-style text-subtle shrink-0 tabular-nums">{nav.dailyCount}</span> : undefined}
          />
        </li>
        {renderFolders(null, 1)}
      </ul>
      {nav.tags.length > 0 && (
        <div className="border-sidebar-border ml-[15px] flex flex-col border-l pt-1.5 pl-1.5">
          <span id={tagsLabel} className="eyebrow-style text-subtle flex h-6 items-center px-2 text-[11px]">
            Tags
          </span>
          <ul role="tree" aria-labelledby={tagsLabel} onKeyDown={onTreeKey} className="flex flex-col">
            {renderTags(nav.tags, 1)}
          </ul>
        </div>
      )}
      <div className="ml-[15px] flex flex-col border-l border-transparent pl-1.5">
        {naming?.parentId === null ? (
          <NameInput label="New folder name" placeholder="Folder name" level={1} onDone={(value) => void finishCreate(null, value)} />
        ) : (
          <Button variant="nav" size="none" onClick={() => startFolder(null)} className="h-7 gap-1.5 px-2 text-[13px]">
            <PlusIcon aria-hidden className="text-subtle size-3 shrink-0" />
            New folder
          </Button>
        )}
        <Button
          variant="nav"
          size="none"
          href={ARCHIVED_HREF}
          onClick={(event) => {
            setSidebarOpen(false);
            if (navigateWithinDocs(ARCHIVED_HREF)) event.preventDefault();
          }}
          className="h-7 gap-1.5 px-2 text-[13px]"
        >
          <ArchiveIcon aria-hidden className="text-subtle size-3 shrink-0" />
          Archived
        </Button>
        {error && (
          <p role="alert" className="caption-style text-danger px-2 pt-1">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

const EMPTY_FOLDERS: Folder[] = [];
