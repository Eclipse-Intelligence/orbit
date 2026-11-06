"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import {
  ApprovalItem,
  CallItem,
  EmailItem,
  ImportItem,
  NudgeItem,
  OthersApprovals,
  PersonItem,
  ReplyItem,
  TaskItem,
  ClearContext,
} from "@/components/capture/capture-items";
import CaptureSeen from "@/components/crm/capture-seen";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import { useComposer } from "@/components/mail/compose-dock";
import KeyboardList from "@/components/shortcuts/keyboard-list";
import { useShortcut } from "@/components/shortcuts/shortcuts-provider";
import { closeFollowUpAction } from "@/app/(crm)/capture/actions";
import type { OthersApproval, WaitingApproval, WaitingTask } from "@/lib/crm/action-needed";
import type { MetPerson } from "@/lib/crm/calendar";
import type { CaptureAction } from "@/lib/crm/capture-actions";
import type { UnfiledImport } from "@/lib/crm/conversations";
import type { FollowUpSuggestion } from "@/lib/crm/follow-ups";
import type { UnknownEmail } from "@/lib/mail/filing";
import type { WorkspaceChoiceRef } from "@/lib/mail/view";
import type { WaitingNudge, WaitingReply } from "@/lib/mail/waiting";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { CAPTURE_SECTIONS, NO_CAPTURE_COUNTS, useCompaniesStore, type CaptureCounts, type CaptureSectionId } from "@/stores/companies-store";

const UNDO_MS = 6_000;

const LABELS: Record<CaptureSectionId, string> = {
  approvals: "Approvals",
  followUps: "Follow-ups",
  replies: "Replies",
  tasks: "Tasks",
  toFile: "To file",
};

export type CaptureData = {
  approvals: WaitingApproval[];
  others: OthersApproval[];
  nudges: WaitingNudge[];
  calls: FollowUpSuggestion[];
  replies: WaitingReply[];
  tasks: WaitingTask[];
  emails: UnknownEmail[];
  unfiled: UnfiledImport[];
  people: MetPerson[];
};

type Entry = { id: string; section: CaptureSectionId; node: ReactNode };

type Pending = {
  id: string;
  action: CaptureAction;
  timer: number;
  toast: number;
};

type Filter = "all" | CaptureSectionId;

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 py-24 text-center sm:py-32">
      <span aria-hidden className="bg-secondary text-subtle mb-1 flex size-10 items-center justify-center rounded-full">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5 10 17.5 19 7.5" />
        </svg>
      </span>
      <h2>Nothing waiting</h2>
    </div>
  );
}

async function post(action: CaptureAction, keepalive: boolean) {
  const response = await fetch("/api/capture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
    keepalive,
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? "That didn't save. Try again.");
}

export default function CaptureScreen({
  viewer,
  data,
  toFileTotal,
  workspaces,
  workspaceId,
  now,
  newestAt,
  alert,
}: {
  viewer: Viewer;
  data: CaptureData;
  toFileTotal: number;
  workspaces: WorkspaceChoiceRef[];
  workspaceId: string;
  now: number;
  newestAt: string | null;
  alert: string | null;
}) {
  const router = useRouter();
  const { showToast, dismissToast } = useComposer();
  const setCaptureCleared = useCompaniesStore((state) => state.setCaptureCleared);
  const [filter, setFilter] = useState<Filter>("all");
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [filing, setFiling] = useState<string | null>(null);
  const pending = useRef<Pending | null>(null);
  const others = workspaces.filter((item) => item.id !== workspaceId);

  const entries: Entry[] = [
    ...data.approvals.map((item) => ({
      id: `approval:${item.id}`,
      section: "approvals" as const,
      node: <ApprovalItem key={item.id} item={item} now={now} clearId={`approval:${item.id}`} />,
    })),
    ...data.nudges.map((item) => ({
      id: `nudge:${item.id}`,
      section: "followUps" as const,
      node: <NudgeItem key={item.id} item={item} now={now} clearId={`nudge:${item.id}`} />,
    })),
    ...data.calls.map((item) => ({
      id: `call:${item.id}`,
      section: "followUps" as const,
      node: (
        <CallItem
          key={item.id}
          item={item}
          now={now}
          clearId={`call:${item.id}`}
          onSent={() => {
            hide(`call:${item.id}`);
            void closeFollowUpAction(item.id, "used").then(() => router.refresh());
          }}
        />
      ),
    })),
    ...data.replies.map((item) => ({
      id: `reply:${item.key}`,
      section: "replies" as const,
      node: <ReplyItem key={item.key} item={item} now={now} clearId={`reply:${item.key}`} />,
    })),
    ...data.tasks.map((item) => ({
      id: `task:${item.id}`,
      section: "tasks" as const,
      node: <TaskItem key={item.id} item={item} now={now} clearId={`task:${item.id}`} />,
    })),
    ...data.emails.map((item) => ({
      id: `email:${item.key}`,
      section: "toFile" as const,
      node: (
        <EmailItem
          key={item.key}
          item={item}
          others={others}
          now={now}
          filing={filing === `email:${item.key}`}
          onFiling={(open) => setFiling(open ? `email:${item.key}` : null)}
          clearId={`email:${item.key}`}
        />
      ),
    })),
    ...data.unfiled.map((item) => ({
      id: `import:${item.id}`,
      section: "toFile" as const,
      node: (
        <ImportItem
          key={item.id}
          item={item}
          now={now}
          filing={filing === `import:${item.id}`}
          onFiling={(open) => setFiling(open ? `import:${item.id}` : null)}
          clearId={`import:${item.id}`}
        />
      ),
    })),
    ...data.people.map((item) => ({
      id: `person:${item.email}`,
      section: "toFile" as const,
      node: <PersonItem key={item.email} item={item} clearId={`person:${item.email}`} />,
    })),
  ];

  const visible = entries.filter((entry) => !hidden.has(entry.id));
  const clearedHere = Object.fromEntries(
    CAPTURE_SECTIONS.map((id) => [id, entries.filter((entry) => entry.section === id && hidden.has(entry.id)).length]),
  ) as CaptureCounts;
  const shownToFile = visible.filter((entry) => entry.section === "toFile").length;
  const counts = Object.fromEntries(
    CAPTURE_SECTIONS.map((id) => [
      id,
      id === "toFile" ? Math.max(shownToFile, toFileTotal - clearedHere.toFile) : visible.filter((entry) => entry.section === id).length,
    ]),
  ) as CaptureCounts;
  const total = CAPTURE_SECTIONS.reduce((sum, id) => sum + counts[id], 0);
  const sections = CAPTURE_SECTIONS.filter((id) => counts[id] > 0);
  const clearedKey = CAPTURE_SECTIONS.map((id) => clearedHere[id]).join(",");

  useEffect(() => {
    const [approvals, followUps, replies, tasks, toFile] = clearedKey.split(",").map(Number);
    setCaptureCleared({ approvals, followUps, replies, tasks, toFile });
  }, [clearedKey, setCaptureCleared]);

  useEffect(() => () => setCaptureCleared(NO_CAPTURE_COUNTS), [setCaptureCleared]);

  function hide(id: string) {
    setHidden((current) => new Set(current).add(id));
  }

  function show(id: string) {
    setHidden((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function commit(item: Pending, keepalive: boolean) {
    post(item.action, keepalive)
      .then(() => {
        if (!keepalive) router.refresh();
      })
      .catch((error: Error) => {
        show(item.id);
        showToast({ message: error.message, tone: "alert" });
      });
  }

  function flush(keepalive = false) {
    const item = pending.current;
    if (!item) return;
    pending.current = null;
    window.clearTimeout(item.timer);
    dismissToast(item.toast);
    commit(item, keepalive);
  }

  function undo() {
    const item = pending.current;
    if (!item) return false;
    pending.current = null;
    window.clearTimeout(item.timer);
    dismissToast(item.toast);
    show(item.id);
    return true;
  }

  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });

  useEffect(() => {
    const away = () => flushRef.current(true);
    const hiddenTab = () => {
      if (document.visibilityState === "hidden") flushRef.current(true);
    };
    window.addEventListener("pagehide", away);
    document.addEventListener("visibilitychange", hiddenTab);
    return () => {
      window.removeEventListener("pagehide", away);
      document.removeEventListener("visibilitychange", hiddenTab);
      flushRef.current(false);
    };
  }, []);

  useShortcut("capture-undo", () => undo());

  function clear(id: string, verb: string, action: CaptureAction) {
    {
      flush();
      setFiling((current) => (current === id ? null : current));
      hide(id);
      const left = total - 1;
      const item: Pending = {
        id,
        action,
        timer: 0,
        toast: showToast({
          message: left > 0 ? `${verb}. ${left} left.` : `${verb}. Nothing left.`,
          duration: UNDO_MS,
          action: { label: "Undo", run: () => void undo() },
        }),
      };
      item.timer = window.setTimeout(() => {
        if (pending.current !== item) return;
        pending.current = null;
        commit(item, false);
      }, UNDO_MS);
      pending.current = item;
    }
  }

  const showing = sections.filter((id) => filter === "all" || filter === id);
  const othersShown = data.others.length > 0 && (filter === "all" || filter === "approvals");

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <CaptureSeen newestAt={newestAt} />
      <SectionHeader title="Capture" viewer={viewer} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-24">
        <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6">
          {alert && (
            <p
              role="alert"
              className="caption-style text-warning flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-white/[0.04] px-3 py-2.5 leading-[1.4]"
            >
              <span>{alert}</span>
              <Button variant="link" size="none" href={`${SETTINGS_PATHS.integrations}#microsoft`} className="caption-style">
                Open Integrations
              </Button>
            </p>
          )}

          {total === 0 ? (
            <EmptyState />
          ) : (
            <div
              role="toolbar"
              aria-label="Filter Capture"
              className="-mx-4 flex gap-1.5 overflow-x-auto [mask-image:linear-gradient(to_right,black_85%,transparent)] px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:[mask-image:none] sm:px-0"
            >
              {(["all", ...sections] as Filter[]).map((id, index) => {
                const label = id === "all" ? "All" : LABELS[id];
                return (
                  <Button
                    key={id}
                    variant={filter === id ? "secondary" : "ghost"}
                    size="sm"
                    aria-pressed={filter === id}
                    data-shortcut={`tab-${index + 1}`}
                    title={`${label} (${index + 1})`}
                    onClick={() => setFilter(id)}
                  >
                    {label}
                    <span className="text-subtle tabular-nums">{id === "all" ? total : counts[id]}</span>
                  </Button>
                );
              })}
            </div>
          )}

          {total > 0 && filter !== "all" && counts[filter] === 0 && (
            <p role="status" className="caption-style text-subtle">
              Nothing left in {LABELS[filter]}.{" "}
              <Button variant="link" size="none" className="caption-style" onClick={() => setFilter("all")}>
                Show all
              </Button>
            </p>
          )}

          <ClearContext.Provider value={clear}>
            <KeyboardList className="flex flex-col gap-6">
              {showing.map((id) => {
                const rows = visible.filter((entry) => entry.section === id);
                return (
                  <section key={id} aria-labelledby={`capture-${id}`} className="flex flex-col gap-3">
                    <h2 id={`capture-${id}`} className="eyebrow-style text-subtle flex items-center gap-2 font-normal">
                      {LABELS[id]}
                      <span className="text-soft tracking-normal tabular-nums">{counts[id]}</span>
                    </h2>
                    {id === "toFile" && counts.toFile > shownToFile && shownToFile > 0 && (
                      <p className="caption-style text-subtle leading-[1.4]">
                        Showing the latest {shownToFile} of {counts.toFile}.
                      </p>
                    )}
                    {rows.length > 0 && (
                      <ul className="bg-card border-line-strong divide-line-strong flex flex-col divide-y overflow-hidden rounded-2xl border">
                        {rows.map((entry) => entry.node)}
                      </ul>
                    )}
                    {id === "approvals" && othersShown && <OthersApprovals items={data.others} />}
                  </section>
                );
              })}
              {othersShown && !showing.includes("approvals") && <OthersApprovals items={data.others} />}
            </KeyboardList>
          </ClearContext.Provider>
        </div>
      </div>
    </section>
  );
}
