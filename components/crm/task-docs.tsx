"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/_ui/sheet";
import { DocPickPopover, DocVisibility } from "@/components/crm/task-doc-picker";
import { useNewNote } from "@/components/docs/record-notes";
import { linkTaskDocAction, taskDocsAction, unlinkTaskDocAction } from "@/app/(crm)/task-docs";
import type { TaskDocEntry } from "@/lib/crm/task-docs";
import type { Task, TaskDoc } from "@/lib/crm/types";
import type { DocPick } from "@/lib/docs/client-types";
import { pageHref } from "@/lib/docs/routes";
import { cn } from "@/lib/utils";
import XIcon from "@/public/assets/images/companies/detail/x.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import ExpandIcon from "@/public/assets/images/docs/expand.svg";
import LockIcon from "@/public/assets/images/docs/lock.svg";
import SunIcon from "@/public/assets/images/docs/sun.svg";
import LinkIcon from "@/public/assets/images/settings/link.svg";

const LINK_FAILED = "Couldn't link the doc. Try again.";
const UNLINK_FAILED = "Couldn't remove the link. Try again.";
const LONG_PRESS_MS = 500;
const MOVE_SLOP = 10;

const CHIP_SHAPE = "bg-secondary text-foreground inline-flex max-w-full items-center gap-1.5 rounded-full py-px pr-2 pl-1.5 text-[12px] leading-5 [@media(pointer:coarse)]:h-7 [@media(pointer:coarse)]:pr-2.5 [@media(pointer:coarse)]:pl-2";
const CHIP = `${CHIP_SHAPE} hit`;

export function othersSeeTask(task: Pick<Task, "ownerId" | "createdByUserId">, viewerId: string, tagged: string[]) {
  return Boolean((task.ownerId && task.ownerId !== viewerId) || (task.createdByUserId && task.createdByUserId !== viewerId) || tagged.some((person) => person !== viewerId));
}

function docName(doc: Pick<TaskDoc, "title">) {
  return doc.title?.trim() || "Untitled";
}

export function LockedDocChip({ className }: { className?: string }) {
  return (
    <span role="img" aria-label="Doc, private" title="Private" className={cn(CHIP_SHAPE, className)}>
      <DocIcon aria-hidden className="text-subtle size-3 shrink-0" />
      <span className="truncate">Doc</span>
      <LockIcon aria-hidden className="text-faint size-3 shrink-0" />
    </span>
  );
}

export function TaskDocChips({ task }: { task: Pick<Task, "docs"> }) {
  return (
    <>
      {task.docs.map((doc) =>
        doc.readable ? (
          <Link key={doc.id} href={pageHref(doc.id)} className={CHIP}>
            <DocIcon aria-hidden className="text-subtle size-3 shrink-0" />
            <span className="truncate">{docName(doc)}</span>
          </Link>
        ) : (
          <LockedDocChip key={doc.id} />
        ),
      )}
    </>
  );
}

function useDocChange(taskId: string, onDone?: () => void) {
  const router = useRouter();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);

  function run(kind: "link" | "unlink", pageId: string) {
    setPending((count) => count + 1);
    setError(null);
    const action = kind === "link" ? linkTaskDocAction : unlinkTaskDocAction;
    const fallback = kind === "link" ? LINK_FAILED : UNLINK_FAILED;
    const next = queue.current.then(async () => {
      const result = await action(taskId, pageId).catch(() => ({ error: fallback }));
      setPending((count) => count - 1);
      if (result.error) {
        setError(result.error);
        return;
      }
      onDone?.();
      router.refresh();
    });
    queue.current = next;
    return next;
  }

  return { busy: pending > 0, error, link: (doc: DocPick) => run("link", doc.id), unlink: (pageId: string) => run("unlink", pageId) };
}

const EDIT_CHIP =
  "[@media(pointer:coarse)]:mr-2.5 inline-flex h-7 max-w-[16rem] min-w-0 items-center gap-1.5 rounded-full bg-white/[0.07] pr-1 pl-2.5 text-[12.5px] leading-none text-foreground [&_svg]:size-3 [&_svg]:shrink-0 [&_svg]:text-subtle max-md:h-[34px] max-md:text-[14px]";
const EMPTY_CHIP =
  "inline-flex h-7 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[12.5px] leading-none whitespace-nowrap text-subtle shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] outline-none transition-[background-color,color] duration-150 ease-power3-out hover:bg-white/[0.03] hover:text-soft focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3 [&_svg]:shrink-0 max-md:h-[34px] max-md:px-[13px] max-md:text-[14px]";

export function EditTaskDocs({ task, warn }: { task: Pick<Task, "id" | "docs" | "docIds">; warn: boolean }) {
  const change = useDocChange(task.id);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      {task.docs.map((doc) => {
        const name = doc.readable ? docName(doc) : "Doc";
        return (
          <span key={doc.id} className={EDIT_CHIP}>
            <DocIcon aria-hidden />
            <span className="truncate">{name}</span>
            {!doc.readable && <LockIcon aria-hidden />}
            <Button
              variant="ghost"
              size="none"
              aria-label={doc.readable ? `Remove link to ${name}` : "Remove link to a private doc"}
              title="Remove"
              onClick={() => void change.unlink(doc.id)}
              className="hit size-5 rounded-full"
            >
              <XIcon aria-hidden />
            </Button>
          </span>
        );
      })}
      <DocPickPopover taskId={task.id} warn={warn} exclude={task.docIds} onPick={(doc) => void change.link(doc)} onClosed={() => trigger.current?.focus()}>
        <button ref={trigger} type="button" aria-label="Link a doc" aria-busy={change.busy || undefined} className={EMPTY_CHIP}>
          <DocIcon aria-hidden />
          Doc
        </button>
      </DocPickPopover>
      {change.busy && (
        <span role="status" className="caption-style text-subtle">
          Saving…
        </span>
      )}
      {change.error && (
        <p role="alert" className="caption-style text-danger basis-full">
          {change.error}
        </p>
      )}
    </>
  );
}

function useTaskDocList(task: Pick<Task, "id" | "docIds" | "updatedAt">) {
  const [state, setState] = useState<{ key: string; docs: TaskDocEntry[]; failed?: boolean } | null>(null);
  const [reloads, setReloads] = useState(0);
  const key = `${task.id}|${task.docIds.join(",")}|${task.updatedAt}|${reloads}`;

  useEffect(() => {
    let live = true;
    void taskDocsAction(task.id)
      .then((result) => {
        if (live) setState({ key, docs: result.docs ?? [], failed: Boolean(result.error) });
      })
      .catch(() => {
        if (live) setState({ key, docs: [], failed: true });
      });
    return () => {
      live = false;
    };
  }, [key, task.id]);

  const current = state?.key === key ? state : null;
  return { docs: current?.docs ?? null, failed: Boolean(current?.failed), reload: () => setReloads((count) => count + 1), stale: state && !current ? state.docs : null };
}

function DocLine({ entry }: { entry: TaskDocEntry }) {
  const reason =
    entry.reason === "linked" ? (
      <span className="inline-flex items-center gap-1">
        <LinkIcon aria-hidden className="size-3 shrink-0" />
        Linked
      </span>
    ) : (
      <span>Mentions this task</span>
    );
  const place = !entry.readable ? "Private" : entry.kind === "daily" ? "Daily note, only you" : (entry.folderPath ?? "Top level");
  return (
    <span className="caption-style text-subtle flex min-w-0 items-center gap-1.5">
      {reason}
      <span aria-hidden>·</span>
      <span className="truncate">{place}</span>
    </span>
  );
}

function DocRow({ entry, removable, onRemove, onMenu }: { entry: TaskDocEntry; removable: boolean; onRemove: () => void; onMenu: () => void }) {
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const pressed = useRef(false);

  if (!entry.readable) {
    return (
      <li className="group/doc flex min-w-0 items-start gap-2.5 py-1 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center" aria-label="Private doc, linked">
        <DocIcon aria-hidden className="text-subtle mt-[3px] size-3.5 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-soft text-[13px] leading-5">Doc</span>
            <LockIcon aria-hidden className="text-faint size-3 shrink-0" />
          </span>
          <DocLine entry={entry} />
        </span>
        {removable && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove link to a private doc"
            title="Remove"
            onClick={onRemove}
            className="hit [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover/doc:opacity-100 [@media(pointer:fine)]:focus-visible:opacity-100"
          >
            <XIcon aria-hidden className="size-3" />
          </Button>
        )}
      </li>
    );
  }

  const Icon = entry.kind === "daily" ? SunIcon : DocIcon;
  const name = docName(entry);

  function startPress(event: PointerEvent<HTMLAnchorElement>) {
    pressed.current = false;
    if (!removable || event.pointerType !== "touch") return;
    const timer = window.setTimeout(() => {
      press.current = null;
      pressed.current = true;
      onMenu();
    }, LONG_PRESS_MS);
    press.current = { timer, x: event.clientX, y: event.clientY };
  }

  function movePress(event: PointerEvent<HTMLAnchorElement>) {
    const current = press.current;
    if (!current) return;
    if (Math.abs(event.clientX - current.x) > MOVE_SLOP || Math.abs(event.clientY - current.y) > MOVE_SLOP) endPress();
  }

  function endPress() {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }

  return (
    <li className="group/doc relative flex min-w-0 items-start">
      <Link
        href={pageHref(entry.id)}
        onPointerDown={startPress}
        onPointerMove={movePress}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        onClick={(event) => {
          if (!pressed.current) return;
          pressed.current = false;
          event.preventDefault();
        }}
        onContextMenu={(event) => {
          if (removable && (press.current || pressed.current)) event.preventDefault();
        }}
        className={cn(
          "focus-visible:ring-ring/60 -mx-1.5 flex min-w-0 flex-1 items-start gap-2.5 rounded-md px-1.5 py-1 outline-none hover:bg-white/[0.04] focus-visible:ring-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:select-none [@media(pointer:coarse)]:[-webkit-touch-callout:none]",
          removable && "pr-10",
        )}
      >
        <Icon aria-hidden className="text-subtle mt-[3px] size-3.5 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-foreground truncate text-[13px] leading-5">{name}</span>
            {entry.kind === "daily" ? <LockIcon aria-label="Private" role="img" className="text-faint size-3 shrink-0" /> : <DocVisibility shared={entry.shared} />}
          </span>
          <DocLine entry={entry} />
        </span>
      </Link>
      {removable && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove link to ${name}`}
          title="Remove"
          onClick={onRemove}
          className="hit absolute top-1 right-0 focus-visible:opacity-100 [@media(pointer:coarse)]:top-2.5 [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-focus-within/doc:opacity-100 [@media(pointer:fine)]:group-hover/doc:opacity-100"
        >
          <XIcon aria-hidden className="size-3" />
        </Button>
      )}
    </li>
  );
}

export default function TaskDocs({ task, canChange, warn }: { task: Task; canChange: boolean; warn: boolean }) {
  const list = useTaskDocList(task);
  const change = useDocChange(task.id, list.reload);
  const note = useNewNote({ kind: "task", id: task.id, name: task.title }, "Couldn't create the doc. Try again.");
  const [menu, setMenu] = useState<TaskDocEntry | null>(null);
  const shown = list.docs ?? list.stale;
  const linkedIds = task.docIds;

  return (
    <section aria-label="Docs" className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center gap-2">
        <h3 className="eyebrow-style flex items-center gap-2">
          Docs
          {shown && shown.length > 0 && <span className="text-subtle tabular-nums">{shown.length}</span>}
        </h3>
        <span className="flex-1" />
        {change.busy && (
          <span role="status" className="caption-style text-subtle">
            Saving…
          </span>
        )}
        {canChange && (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={note.creating}
              aria-label={`New doc about ${task.title}`}
              onClick={() => void note.create()}
              className="hit"
            >
              New doc
            </Button>
            <DocPickPopover taskId={task.id} warn={warn} exclude={linkedIds} align="end" onPick={(doc) => void change.link(doc)}>
              <Button variant="secondary" size="sm" aria-busy={change.busy || undefined} className="hit">
                <LinkIcon aria-hidden className="size-3" />
                Link a doc
              </Button>
            </DocPickPopover>
          </>
        )}
      </div>
      {note.error && (
        <p role="alert" className="caption-style text-danger">
          {note.error}
        </p>
      )}
      {change.error && (
        <p role="alert" className="caption-style text-danger">
          {change.error}
        </p>
      )}
      {list.failed ? (
        <p role="alert" className="caption-style text-danger">
          Couldn&apos;t load docs. Reload to try again.
        </p>
      ) : shown === null ? (
        <p role="status" className="caption-style text-subtle">
          Loading…
        </p>
      ) : shown.length === 0 ? (
        <p className="caption-style text-subtle">No docs</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {shown.map((entry) => (
            <DocRow
              key={entry.id}
              entry={entry}
              removable={canChange && entry.reason === "linked"}
              onRemove={() => void change.unlink(entry.id)}
              onMenu={() => setMenu(entry)}
            />
          ))}
        </ul>
      )}
      <Sheet open={menu !== null} onOpenChange={(open) => !open && setMenu(null)}>
        <SheetContent side="bottom" className="gap-1 px-2 pt-2">
          <SheetTitle className="sr-only">{menu ? docName(menu) : "Doc"}</SheetTitle>
          <SheetDescription className="sr-only">Actions for this doc</SheetDescription>
          {menu && (
            <div className="flex min-w-0 items-start gap-2.5 px-4 pt-1 pb-2">
              <DocIcon aria-hidden className="text-subtle mt-1 size-4 shrink-0" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-foreground truncate text-[15px] font-medium">{docName(menu)}</span>
                <DocLine entry={menu} />
              </span>
            </div>
          )}
          {menu && (
            <Button variant="ghost" size="md" href={pageHref(menu.id)} onClick={() => setMenu(null)} className="text-foreground h-12 w-full justify-start gap-3 rounded-xl px-4 text-[16px] font-normal">
              <ExpandIcon aria-hidden className="size-4" />
              Open
            </Button>
          )}
          {menu && (
            <Button
              variant="ghost"
              size="md"
              onClick={() => {
                const id = menu.id;
                setMenu(null);
                void change.unlink(id);
              }}
              className="text-danger hover:text-danger h-12 w-full justify-start gap-3 rounded-xl px-4 text-[16px] font-normal"
            >
              <XIcon aria-hidden className="size-4" />
              Remove link
            </Button>
          )}
          <Button variant="ghost" size="md" onClick={() => setMenu(null)} className="text-subtle h-12 w-full rounded-xl px-4 text-[16px] font-normal">
            Cancel
          </Button>
        </SheetContent>
      </Sheet>
    </section>
  );
}
