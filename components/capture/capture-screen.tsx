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
  ReminderItem,
  ReplyItem,
  TaskItem,
  ClearContext,
  type ClearInstead,
} from "@/components/capture/capture-items";
import Dismissed from "@/components/capture/dismissed";
import NotShown from "@/components/capture/not-shown";
import { OFFLINE, postCapture } from "@/components/capture/capture-post";
import { CaptureListContext, COLLAPSE_MS } from "@/components/capture/capture-row";
import CaptureSeen from "@/components/crm/capture-seen";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import { useComposer } from "@/components/mail/compose-dock";
import KeyboardList, { activateRow } from "@/components/shortcuts/keyboard-list";
import { useShortcut } from "@/components/shortcuts/shortcuts-provider";
import { closeFollowUpAction } from "@/app/(crm)/capture/actions";
import type { OthersApproval, WaitingApproval, WaitingTask } from "@/lib/crm/action-needed";
import type { MetPerson } from "@/lib/crm/calendar";
import type { CaptureAction, CaptureOutcome } from "@/lib/crm/capture-actions";
import type { DismissedImport, UnfiledImport } from "@/lib/crm/conversations";
import type { FollowUpSuggestion } from "@/lib/crm/follow-ups";
import { contactHref } from "@/lib/crm/hrefs";
import type { SkippedEmail } from "@/lib/mail/capture-filter";
import type { SenderRule } from "@/lib/mail/relevance";
import type { UnknownEmail } from "@/lib/mail/filing";
import type { WorkspaceChoiceRef } from "@/lib/mail/view";
import type { WaitingNudge, WaitingReminder, WaitingReply } from "@/lib/mail/waiting";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { cn } from "@/lib/utils";
import { CAPTURE_SECTIONS, NO_CAPTURE_COUNTS, useCompaniesStore, type CaptureCounts, type CaptureSectionId } from "@/stores/companies-store";
import CheckIcon from "@/public/assets/images/assistant/check.svg";

const UNDO_MS = 6_000;
const FILING_MS = 30_000;
const SETTLE_MS = 250;

const LABELS: Record<CaptureSectionId, string> = {
  approvals: "Approvals",
  followUps: "Follow-ups",
  replies: "Replies",
  tasks: "Tasks",
  toFile: "To file",
};

const FILED = new Set<CaptureAction["kind"]>(["email-create", "email-file", "import-create", "import-file", "person-create"]);

export type CaptureData = {
  approvals: WaitingApproval[];
  others: OthersApproval[];
  nudges: WaitingNudge[];
  reminders: WaitingReminder[];
  calls: FollowUpSuggestion[];
  replies: WaitingReply[];
  tasks: WaitingTask[];
  emails: UnknownEmail[];
  notShown: SkippedEmail[];
  unfiled: UnfiledImport[];
  people: MetPerson[];
  dismissed: DismissedImport[];
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
        <CheckIcon className="size-4" />
      </span>
      <h2>Nothing waiting</h2>
    </div>
  );
}

function liveRows() {
  return [...document.querySelectorAll<HTMLElement>("[data-capture-row]")].filter(
    (row) => !row.hasAttribute("data-leaving") && row.getClientRects().length > 0,
  );
}

function ChipStrip({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [end, setEnd] = useState(true);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setEnd(element.scrollLeft + element.clientWidth >= element.scrollWidth - 2);
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Filter Capture"
      className={cn(
        "-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0",
        !end && "[mask-image:linear-gradient(to_right,black_85%,transparent)] sm:[mask-image:none]",
      )}
    >
      {children}
    </div>
  );
}

export default function CaptureScreen({
  viewer,
  data,
  toFileTotal,
  notShownTotal,
  dismissedTotal,
  sorting,
  rules,
  failed,
  workspaces,
  workspaceId,
  now,
  newestAt,
  alert,
}: {
  viewer: Viewer;
  data: CaptureData;
  toFileTotal: number;
  notShownTotal: number;
  dismissedTotal: number;
  sorting: number;
  rules: SenderRule[];
  failed: CaptureSectionId[];
  workspaces: WorkspaceChoiceRef[];
  workspaceId: string;
  now: number;
  newestAt: string | null;
  alert: string | null;
}) {
  const router = useRouter();
  const { showToast, dismissToast } = useComposer();
  const setCaptureCleared = useCompaniesStore((state) => state.setCaptureCleared);
  const setCaptureLive = useCompaniesStore((state) => state.setCaptureLive);
  const [filter, setFilter] = useState<Filter>("all");
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const [filing, setFiling] = useState<string | null>(null);
  const pending = useRef<Pending | null>(null);
  const mounted = useRef(true);
  const settleUntil = useRef(0);
  const swipedRow = useRef<string | null>(null);
  const leaveTimers = useRef(new Map<string, number>());
  const others = workspaces.filter((item) => item.id !== workspaceId);
  const unread = new Set(failed);

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
    ...data.reminders.map((item) => ({
      id: `reminder:${item.id}`,
      section: "followUps" as const,
      node: <ReminderItem key={item.id} item={item} now={now} clearId={`reminder:${item.id}`} />,
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
            void closeFollowUpAction(item.id, "used")
              .then((result) => {
                if (result.error) showToast({ message: result.error, tone: "alert" });
                router.refresh();
              })
              .catch(() => showToast({ message: OFFLINE, tone: "alert" }));
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
          others={others}
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

  const gone = (id: string) => hidden.has(id) || leaving.has(id);
  const shown = entries.filter((entry) => !hidden.has(entry.id));
  const clearedHere = Object.fromEntries(
    CAPTURE_SECTIONS.map((id) => [id, entries.filter((entry) => entry.section === id && gone(entry.id)).length]),
  ) as CaptureCounts;
  const left = (id: CaptureSectionId) => entries.filter((entry) => entry.section === id && !gone(entry.id)).length;
  const leftToFile = left("toFile");
  const counts = Object.fromEntries(
    CAPTURE_SECTIONS.map((id) => [id, id === "toFile" ? Math.max(leftToFile, toFileTotal - clearedHere.toFile) : left(id)]),
  ) as CaptureCounts;
  const total = CAPTURE_SECTIONS.reduce((sum, id) => sum + counts[id], 0);
  const sections = CAPTURE_SECTIONS.filter((id) => counts[id] > 0 || unread.has(id));
  const clearedKey = CAPTURE_SECTIONS.map((id) => clearedHere[id]).join(",");
  const view: Filter = filter !== "all" && counts[filter] === 0 && !unread.has(filter) ? "all" : filter;

  useEffect(() => {
    const [approvals, followUps, replies, tasks, toFile] = clearedKey.split(",").map(Number);
    setCaptureCleared({ approvals, followUps, replies, tasks, toFile });
  }, [clearedKey, setCaptureCleared]);

  useEffect(() => {
    mounted.current = true;
    setCaptureLive(true);
    return () => {
      mounted.current = false;
      setCaptureLive(false);
    };
  }, [setCaptureLive]);

  function hide(id: string) {
    setHidden((current) => new Set(current).add(id));
  }

  function settle(id: string) {
    leaveTimers.current.delete(id);
    hide(id);
    setLeaving((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function leave(id: string) {
    setLeaving((current) => new Set(current).add(id));
    leaveTimers.current.set(
      id,
      window.setTimeout(() => settle(id), COLLAPSE_MS),
    );
  }

  function show(id: string) {
    const timer = leaveTimers.current.get(id);
    if (timer) window.clearTimeout(timer);
    leaveTimers.current.delete(id);
    setLeaving((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setHidden((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function filed(outcome: Partial<CaptureOutcome>, action: CaptureAction) {
    if (!FILED.has(action.kind) || !outcome.contactId || !mounted.current) return;
    const contactId = outcome.contactId;
    const name = outcome.contactName?.trim() || "the contact";
    showToast({
      message: action.kind === "person-create" ? `${name} is now a contact` : `Filed to ${name}`,
      action: { label: "Open", run: () => router.push(contactHref(contactId)) },
    });
  }

  function commit(item: Pending, keepalive: boolean) {
    dismissToast(item.toast);
    const filing = FILED.has(item.action.kind) && mounted.current ? showToast({ message: "Filing…", duration: FILING_MS }) : null;
    postCapture(item.action, workspaceId, keepalive)
      .then((outcome) => {
        if (filing !== null) dismissToast(filing);
        filed(outcome, item.action);
        router.refresh();
      })
      .catch((error: Error) => {
        if (filing !== null) dismissToast(filing);
        if (!mounted.current) {
          setCaptureCleared(NO_CAPTURE_COUNTS);
          return;
        }
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
  const queueRef = useRef<(id: string, verb: string, action: CaptureAction) => void>(() => undefined);
  useEffect(() => {
    flushRef.current = flush;
  });

  useEffect(() => {
    const timers = leaveTimers.current;
    const away = () => flushRef.current(true);
    const visibility = () => {
      if (document.visibilityState === "hidden") flushRef.current(true);
      else router.refresh();
    };
    window.addEventListener("pagehide", away);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", away);
      document.removeEventListener("visibilitychange", visibility);
      timers.forEach((timer) => window.clearTimeout(timer));
      flushRef.current(true);
    };
  }, [router]);

  useShortcut("capture-undo", () => undo());

  function moveFocusFrom(id: string) {
    const rows = liveRows();
    const index = rows.findIndex((row) => row.dataset.captureRow === id);
    if (index < 0) return;
    const row = rows[index];
    const focused = row.dataset.kbActive === "true" || row.contains(document.activeElement);
    const next = rows[index + 1] ?? rows[index - 1] ?? null;
    if (focused && next) activateRow(next);
  }

  function clear(id: string, verb: string, action: CaptureAction, instead?: ClearInstead) {
    const swiped = swipedRow.current === id;
    swipedRow.current = null;
    if (!swiped && Date.now() < settleUntil.current) return;
    settleUntil.current = Date.now() + SETTLE_MS;
    flush();
    setFiling((current) => (current === id ? null : current));
    moveFocusFrom(id);
    if (swiped) hide(id);
    else leave(id);
    queue(id, verb, action, instead);
  }

  function queue(id: string, verb: string, action: CaptureAction, instead?: ClearInstead) {
    const item: Pending = {
      id,
      action,
      timer: 0,
      toast: showToast({
        message: verb,
        duration: UNDO_MS,
        action: { label: "Undo", run: () => void undo() },
        ...(instead
          ? {
              extra: {
                label: instead.label,
                short: instead.short,
                run: () => {
                  if (pending.current !== item) return;
                  window.clearTimeout(item.timer);
                  pending.current = null;
                  queueRef.current(id, instead.done, instead.action);
                },
              },
            }
          : {}),
      }),
    };
    item.timer = window.setTimeout(() => {
      if (pending.current !== item) return;
      pending.current = null;
      commit(item, false);
    }, UNDO_MS);
    pending.current = item;
  }

  useEffect(() => {
    queueRef.current = queue;
  });

  const showing = sections.filter((id) => view === "all" || view === id);
  const othersShown = data.others.length > 0 && (view === "all" || view === "approvals");
  const nothing = total === 0 && unread.size === 0;
  const notShownHere = (notShownTotal > 0 || rules.length > 0 || sorting > 0) && (view === "all" || view === "toFile");
  const dismissedHere = dismissedTotal > 0 && (view === "all" || view === "toFile");

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
              <Button variant="link" size="none" href={`${SETTINGS_PATHS.email}#microsoft`} className="caption-style">
                Email settings
              </Button>
            </p>
          )}

          {nothing ? (
            <EmptyState />
          ) : (
            <ChipStrip>
              {(["all", ...sections] as Filter[]).map((id, index) => {
                const label = id === "all" ? "All" : LABELS[id];
                const count = id === "all" ? total : unread.has(id) && counts[id] === 0 ? null : counts[id];
                return (
                  <Button
                    key={id}
                    variant={view === id ? "secondary" : "ghost"}
                    size="sm"
                    aria-pressed={view === id}
                    data-shortcut={`tab-${index + 1}`}
                    title={`${label} (${index + 1})`}
                    onClick={() => setFilter(id)}
                  >
                    {label}
                    {count !== null && <span className="text-subtle tabular-nums">{count}</span>}
                  </Button>
                );
              })}
            </ChipStrip>
          )}

          <CaptureListContext.Provider
            value={{
              leaving,
              swiped: (id) => {
                swipedRow.current = id;
              },
            }}
          >
            <ClearContext.Provider value={clear}>
              <KeyboardList className="flex flex-col gap-6">
                {showing.map((id) => {
                  const rows = shown.filter((entry) => entry.section === id);
                  return (
                    <section key={id} aria-labelledby={`capture-${id}`} className="flex flex-col gap-3">
                      <h2 id={`capture-${id}`} className="eyebrow-style text-subtle flex items-center gap-2 font-normal">
                        {LABELS[id]}
                        {counts[id] > 0 && <span className="text-soft tracking-normal tabular-nums">{counts[id]}</span>}
                      </h2>
                      {unread.has(id) && (
                        <p role="alert" className="caption-style text-warning leading-[1.4]">
                          {LABELS[id]} didn&apos;t load. Reload.
                        </p>
                      )}
                      {id === "toFile" && counts.toFile > leftToFile && leftToFile > 0 && (
                        <p className="caption-style text-subtle leading-[1.4]">
                          Showing the latest {leftToFile} of {counts.toFile}.
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
              {(notShownHere || dismissedHere) && (
                <div className="flex flex-col gap-1">
                  {notShownHere && <NotShown items={data.notShown} total={notShownTotal} sorting={sorting} rules={rules} workspaceId={workspaceId} />}
                  {dismissedHere && <Dismissed items={data.dismissed} total={dismissedTotal} now={now} workspaceId={workspaceId} />}
                </div>
              )}
            </ClearContext.Provider>
          </CaptureListContext.Provider>
        </div>
      </div>
    </section>
  );
}
