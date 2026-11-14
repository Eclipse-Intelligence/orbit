"use client";

import { useEffect, useMemo, useState, type ComponentType, type MouseEvent, type ReactNode, type SVGProps } from "react";
import Link from "next/link";
import { Monogram } from "@/components/beautifui/record-marks";
import { ParticipantAvatar } from "@/components/docs/presence";
import { navigateWithinDocs, useDocsNow } from "@/components/docs/use-docs";
import { taskPanelHref } from "@/lib/chat/discussions";
import { taskDueLabel, taskDueState } from "@/lib/crm/task-views";
import type { Backlinks, LinkContext, Page, PageTask, RecordRef } from "@/lib/docs/client-types";
import { docsData } from "@/lib/docs/connection";
import { whenLabel } from "@/lib/docs/format";
import { linkTitlesIn, parseMentions } from "@/lib/docs/markdown";
import { participantInitials, personParticipant } from "@/lib/docs/participants";
import { listHref, pageHref, recordHref } from "@/lib/docs/routes";
import { useDocsStore } from "@/stores/docs-store";
import { cn } from "@/lib/utils";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import FileSignatureIcon from "@/public/assets/images/companies/sidebar/file-signature.svg";
import TargetIcon from "@/public/assets/images/companies/sidebar/target-05.svg";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import LockIcon from "@/public/assets/images/docs/lock.svg";
import SunIcon from "@/public/assets/images/docs/sun.svg";

function RailSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 px-4 pt-4">
      <div className="flex h-5 items-center gap-2">
        <h3 className="eyebrow-style text-subtle text-[11px] font-medium">{title}</h3>
        {count !== undefined && <span className="caption-style text-subtle tabular-nums">{count}</span>}
      </div>
      {children}
    </section>
  );
}

function within(event: MouseEvent<HTMLElement>, href: string) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  if (navigateWithinDocs(href)) event.preventDefault();
}

function Snippet({ context, linked }: { context: LinkContext; linked: boolean }) {
  const before = context.snippet.slice(0, context.matchFrom);
  const match = context.snippet.slice(context.matchFrom, context.matchTo);
  const after = context.snippet.slice(context.matchTo);
  return (
    <span className="text-subtle text-[12.5px] leading-[1.5]">
      {before}
      <span className={cn("text-soft", linked ? "underline decoration-[#8b7bff]/70 decoration-1 underline-offset-[3px]" : "bg-white/[0.06] rounded-[3px] px-[1px]")}>{match}</span>
      {after}
    </span>
  );
}

function BacklinkCard({ context, linked, now }: { context: LinkContext; linked: boolean; now: string }) {
  const href = pageHref(context.pageId);
  const Icon = context.kind === "daily" ? SunIcon : DocIcon;
  return (
    <li>
      <Link
        href={href}
        onClick={(event) => within(event, href)}
        className="ease-power3-out focus-visible:ring-ring/60 flex flex-col gap-1.5 rounded-xl bg-white/[0.03] p-3 transition-colors duration-150 outline-none hover:bg-white/[0.05] focus-visible:ring-2"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon aria-hidden className="text-subtle size-3.5 shrink-0" />
          <span className="text-foreground min-w-0 truncate text-[13px] leading-4 font-medium">{context.title || "Untitled"}</span>
        </span>
        <Snippet context={context} linked={linked} />
        <span className="caption-style text-subtle flex items-center gap-1.5">
          {context.kind === "daily" ? (
            <>
              <LockIcon aria-hidden className="size-3" /> Daily note, only you
            </>
          ) : (
            <>
              {context.folderName ?? "Top level"} <span aria-hidden>·</span> {whenLabel(context.updatedAt, now)}
            </>
          )}
        </span>
      </Link>
    </li>
  );
}

function RecordIcon({ record }: { record: RecordRef }) {
  if (record.kind === "company") return <Monogram name={record.name} className="size-6 rounded-lg text-[11px]" />;
  if (record.kind === "contact" || record.kind === "member") {
    return (
      <ParticipantAvatar
        participant={{ id: record.id, name: record.name, short: record.name, initials: participantInitials(record.name), color: "oklch(0.70 0.13 162)", kind: "person" }}
        size="md"
      />
    );
  }
  const Icon: ComponentType<SVGProps<SVGSVGElement>> = record.kind === "opportunity" ? ClipboardIcon : record.kind === "proposal" ? FileSignatureIcon : TargetIcon;
  return (
    <span className="bg-secondary text-subtle flex size-6 shrink-0 items-center justify-center rounded-lg">
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}

function RecordRow({ icon, name, detail, href, internal }: { icon: ReactNode; name: string; detail: string | null; href: string; internal?: boolean }) {
  return (
    <li>
      <Link
        href={href}
        onClick={internal ? (event) => within(event, href) : undefined}
        className="ease-power3-out focus-visible:ring-ring/60 -mx-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-150 outline-none hover:bg-white/[0.04] focus-visible:ring-2"
      >
        {icon}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-foreground truncate text-[13px] leading-4">{name}</span>
          {detail && <span className="caption-style text-subtle truncate">{detail}</span>}
        </span>
      </Link>
    </li>
  );
}

function firstNameOf(name: string | null) {
  return name?.trim().split(/\s+/)[0] ?? "";
}

function pageTaskDetail(task: PageTask, now: number) {
  const owner = firstNameOf(task.ownerName);
  if (task.completedAt) return { text: ["Done", owner].filter(Boolean).join(" · "), late: false };
  const state = taskDueState(task.dueAt, now);
  const due = state.kind === "overdue" ? "Overdue" : state.kind === "today" ? "Due today" : state.kind === "none" ? null : `Due ${taskDueLabel(task, now)}`;
  return { text: [due, owner].filter(Boolean).join(" · "), late: state.kind === "overdue" };
}

function PageTaskRow({ task, now }: { task: PageTask; now: number }) {
  const detail = pageTaskDetail(task, now);
  const Icon = task.completedAt ? CheckIcon : TargetIcon;
  return (
    <li>
      <Link
        href={taskPanelHref(task.id, { tagged: task.tagged })}
        className="ease-power3-out focus-visible:ring-ring/60 -mx-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-150 outline-none hover:bg-white/[0.04] focus-visible:ring-2 [@media(pointer:coarse)]:min-h-11"
      >
        <span className="bg-secondary text-subtle flex size-6 shrink-0 items-center justify-center rounded-lg">
          <Icon aria-hidden className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("truncate text-[13px] leading-4", task.completedAt ? "text-subtle line-through" : "text-foreground")}>{task.title}</span>
          {detail.text && <span className={cn("caption-style truncate", detail.late ? "text-danger" : "text-subtle")}>{detail.text}</span>}
        </span>
        {task.ownerId && <ParticipantAvatar participant={personParticipant({ id: task.ownerId, name: task.ownerName ?? "Former member" }, null)} size="sm" />}
      </Link>
    </li>
  );
}

function PageTasks({ pageId }: { pageId: string }) {
  const [tasks, setTasks] = useState<{ id: string; value: PageTask[] } | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    void docsData()
      .pageTasks(pageId)
      .then((value) => {
        if (live) setTasks({ id: pageId, value });
      })
      .catch(() => {
        if (live) setTasks({ id: pageId, value: [] });
      });
    return () => {
      live = false;
    };
  }, [pageId]);

  const list = tasks?.id === pageId ? tasks.value : [];
  if (list.length === 0) return null;
  const open = list.filter((task) => !task.completedAt);
  const done = list.filter((task) => task.completedAt);
  return (
    <RailSection title="Tasks" count={open.length}>
      {open.length > 0 && (
        <ul className="flex flex-col">
          {open.map((task) => (
            <PageTaskRow key={task.id} task={task} now={now} />
          ))}
        </ul>
      )}
      {done.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showDone}
            onClick={() => setShowDone((value) => !value)}
            className="caption-style text-subtle hover:text-foreground focus-visible:ring-ring/60 hit flex items-center gap-1.5 self-start rounded-md py-1 transition-colors duration-150 outline-none focus-visible:ring-2"
          >
            {done.length} done
            <ChevronRightIcon aria-hidden className={cn("ease-power3-out size-3 transition-transform duration-150", showDone && "rotate-90")} />
          </button>
          {showDone && (
            <ul className="flex flex-col">
              {done.map((task) => (
                <PageTaskRow key={task.id} task={task} now={now} />
              ))}
            </ul>
          )}
        </>
      )}
    </RailSection>
  );
}

export default function NoteRail({ page }: { page: Page }) {
  const now = useDocsNow();
  const titles = useDocsStore((state) => state.titles);
  const summaries = useDocsStore((state) => state.summaries);
  const [backlinks, setBacklinks] = useState<{ id: string; value: Backlinks } | null>(null);
  const [records, setRecords] = useState<{ key: string; value: RecordRef[] } | null>(null);
  const [showUnlinked, setShowUnlinked] = useState(false);
  const mentions = useMemo(() => parseMentions(page.body), [page.body]);
  const mentionKey = mentions.map((mention) => `${mention.kind}:${mention.id}`).join(",");
  const linkedNotes = useMemo(
    () =>
      linkTitlesIn(page.body)
        .map((title) => ({ title, id: titles[title.toLowerCase()] ?? titles[title] }))
        .filter((item): item is { title: string; id: string } => Boolean(item.id) && item.id !== page.id),
    [page.body, page.id, titles],
  );

  useEffect(() => {
    let live = true;
    void docsData()
      .backlinks(page.id)
      .then((value) => {
        if (live) setBacklinks({ id: page.id, value });
      })
      .catch(() => {
        if (live) setBacklinks({ id: page.id, value: { linked: [], unlinked: [] } });
      });
    return () => {
      live = false;
    };
  }, [page.id, titles]);

  useEffect(() => {
    let live = true;
    if (!mentions.length) return;
    void docsData()
      .recordDetails(mentions)
      .then((value) => {
        if (live) setRecords({ key: mentionKey, value });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [mentionKey, mentions]);

  const links = backlinks?.id === page.id ? backlinks.value : null;
  const recordList = mentions.length && records?.key === mentionKey ? records.value : mentions.map((mention) => ({ ...mention, detail: null }));

  return (
    <div className="flex flex-col gap-2 pb-28">
      <RailSection title="Backlinks" count={links?.linked.length}>
        {links === null ? (
          <p role="status" className="caption-style text-subtle">
            Loading…
          </p>
        ) : links.linked.length === 0 ? (
          <p className="caption-style text-subtle">No backlinks</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {links.linked.map((context) => (
              <BacklinkCard key={context.pageId} context={context} linked now={now} />
            ))}
          </ul>
        )}
        {links && links.unlinked.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={showUnlinked}
              onClick={() => setShowUnlinked((value) => !value)}
              className="caption-style text-subtle hover:text-foreground focus-visible:ring-ring/60 flex items-center gap-1.5 self-start rounded-md py-1 transition-colors duration-150 outline-none focus-visible:ring-2"
            >
              {links.unlinked.length} unlinked {links.unlinked.length === 1 ? "mention" : "mentions"}
              <ChevronRightIcon aria-hidden className={cn("ease-power3-out size-3 transition-transform duration-150", showUnlinked && "rotate-90")} />
            </button>
            {showUnlinked && (
              <ul className="flex flex-col gap-2">
                {links.unlinked.map((context) => (
                  <BacklinkCard key={context.pageId} context={context} linked={false} now={now} />
                ))}
              </ul>
            )}
          </>
        )}
      </RailSection>
      {page.kind !== "daily" && <PageTasks pageId={page.id} />}
      {(recordList.length > 0 || linkedNotes.length > 0) && (
        <RailSection title="In this note">
          <ul className="flex flex-col">
            {recordList.map((record) => (
              <RecordRow key={`${record.kind}:${record.id}`} icon={<RecordIcon record={record} />} name={record.name} detail={record.detail} href={recordHref(record.kind, record.id)} />
            ))}
            {linkedNotes.map((note) => (
              <RecordRow
                key={note.id}
                internal
                icon={
                  <span className="bg-secondary text-subtle flex size-6 shrink-0 items-center justify-center rounded-lg">
                    {summaries[note.id]?.kind === "daily" ? <SunIcon aria-hidden className="size-3.5" /> : <DocIcon aria-hidden className="size-3.5" />}
                  </span>
                }
                name={summaries[note.id]?.title || note.title}
                detail="Note"
                href={pageHref(note.id)}
              />
            ))}
          </ul>
        </RailSection>
      )}
      {page.tags.length > 0 && (
        <RailSection title="Tags">
          <div className="flex flex-wrap gap-1.5">
            {page.tags.map((tag) => {
              const href = listHref({ kind: "tag", path: tag });
              return (
                <Link
                  key={tag}
                  href={href}
                  onClick={(event) => within(event, href)}
                  className="text-soft hover:text-foreground focus-visible:ring-ring/60 rounded-md bg-white/[0.05] px-2 py-1 text-[12.5px] leading-none transition-colors duration-150 outline-none focus-visible:ring-2"
                >
                  <span className="text-faint">#</span>
                  {tag}
                </Link>
              );
            })}
          </div>
        </RailSection>
      )}
    </div>
  );
}
