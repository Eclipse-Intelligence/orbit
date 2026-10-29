"use client";

import { useEffect, useId, useRef, useState, type ComponentType, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type SVGProps } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import Button from "@/components/_ui/button";
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
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [naming, setNaming] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop>(null);
  const cancelled = useRef(false);
  const tagsLabel = useId();

  const onDocs = pathname === "/docs" || pathname.startsWith("/docs/");
  const route = onDocs ? parseDocsRoute(pathname, params) : null;
  const pageFolder = useDocsStore((state) => (route?.pageId ? (state.summaries[route.pageId]?.folderId ?? null) : null));
  const pageDaily = useDocsStore((state) => (route?.pageId ? state.summaries[route.pageId]?.kind === "daily" : false));

  useEffect(() => {
    const timer = window.setTimeout(() => setOpen(readOpen()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (!nav) return null;
  const activeFolder = route?.list.kind === "folder" ? route.list.folderId : route?.pageId && route.list.kind === "all" ? pageFolder : null;
  const activeTag = route?.list.kind === "tag" ? route.list.path : null;
  const dailyActive = route?.list.kind === "daily" || pageDaily;
  const allActive = Boolean(route && route.list.kind === "all" && !route.pageId && !dailyActive);
  const viewerId = nav.viewer.id;
  const isOpen = (key: string, fallback: boolean) => open[key] ?? fallback;
  const toggle = (key: string, fallback: boolean) =>
    setOpen((current) => {
      const next = { ...current, [key]: !(current[key] ?? fallback) };
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });

  const children = (parentId: string | null) => nav.folders.filter((folder) => folder.parentId === parentId).sort((left, right) => left.position - right.position);
  const tabbableHref = activeFolder ? listHref({ kind: "folder", folderId: activeFolder }) : "/docs/daily";
  const tabbableTag = activeTag ? listHref({ kind: "tag", path: activeTag }) : nav.tags[0] ? listHref({ kind: "tag", path: nav.tags[0].path }) : null;

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
      const siblings = children(folder.parentId).filter((item) => item.id !== dragged);
      const index = siblings.findIndex((item) => item.id === folder.id);
      void moveFolder(dragged, folder.parentId, place === "before" ? index : index + 1);
    };
  }

  function reorderKey(folder: Folder) {
    return (event: KeyboardEvent<HTMLAnchorElement>) => {
      if (event.key === "F2") {
        event.preventDefault();
        setRenaming(folder.id);
        return;
      }
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      event.stopPropagation();
      const siblings = children(folder.parentId);
      const index = siblings.findIndex((item) => item.id === folder.id);
      const target = index + (event.key === "ArrowUp" ? -1 : 1);
      if (target < 0 || target >= siblings.length) return;
      void moveFolder(folder.id, folder.parentId, target);
    };
  }

  async function finishRename(folder: Folder, value: string) {
    setRenaming(null);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const name = value.trim();
    if (!name || name === folder.name) return;
    const problem = await renameFolder(folder.id, name);
    if (problem) setError(problem);
  }

  async function finishCreate(value: string) {
    const name = value.trim();
    setNaming(false);
    if (cancelled.current || !name) {
      cancelled.current = false;
      return;
    }
    const folder = await createFolder(name, null);
    if (folder) {
      setSidebarOpen(false);
      navigate(listHref({ kind: "folder", folderId: folder.id }));
    }
  }

  function renderFolders(parentId: string | null, level: number): ReactNode {
    return children(parentId).map((folder) => {
      const nested = children(folder.id).length > 0;
      const key = `folder:${folder.id}`;
      const expanded = nested ? isOpen(key, true) : undefined;
      const href = listHref({ kind: "folder", folderId: folder.id });
      return (
        <li key={folder.id} role="none">
          {renaming === folder.id ? (
            <input
              autoFocus
              defaultValue={folder.name}
              aria-label="Folder name"
              maxLength={120}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  cancelled.current = true;
                  event.currentTarget.blur();
                }
              }}
              onBlur={(event) => void finishRename(folder, event.currentTarget.value)}
              className="bg-sidebar-primary text-foreground focus-visible:ring-ring/60 h-7 w-full rounded-lg px-2 text-[13.5px] outline-none focus-visible:ring-2"
            />
          ) : (
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
              onKeyDown={reorderKey(folder)}
              onDoubleClick={() => setRenaming(folder.id)}
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
          )}
          {nested && expanded && (
            <ul role="group" className="flex flex-col">
              {renderFolders(folder.id, level + 1)}
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
      <ul role="tree" aria-label="Docs folders" onKeyDown={onTreeKey} className="border-sidebar-border ml-[15px] flex flex-col border-l pl-1.5">
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
          <span id={tagsLabel} className="eyebrow-style text-faint flex h-6 items-center px-2 text-[11px]">
            Tags
          </span>
          <ul role="tree" aria-labelledby={tagsLabel} onKeyDown={onTreeKey} className="flex flex-col">
            {renderTags(nav.tags, 1)}
          </ul>
        </div>
      )}
      <div className="ml-[15px] border-l border-transparent pl-1.5">
        {naming ? (
          <input
            autoFocus
            aria-label="New folder name"
            placeholder="Folder name"
            maxLength={120}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                cancelled.current = true;
                event.currentTarget.blur();
              }
            }}
            onBlur={(event) => void finishCreate(event.currentTarget.value)}
            className="bg-sidebar-primary text-foreground placeholder:text-subtle focus-visible:ring-ring/60 h-7 w-full rounded-lg px-2 text-[13.5px] outline-none focus-visible:ring-2"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setNaming(true);
            }}
            className="text-faint hover:text-foreground focus-visible:ring-ring/60 flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2"
          >
            <PlusIcon aria-hidden className="size-3 shrink-0" />
            New folder
          </button>
        )}
        {error && (
          <p role="alert" className="caption-style text-danger px-2 pt-1">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
