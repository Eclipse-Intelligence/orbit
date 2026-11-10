"use client";

import WorkspaceTile from "@/components/workspaces/workspace-tile";
import { useCallback, useEffect, useEffectEvent, useId, useRef, useState, type CSSProperties, type DragEvent, type FormEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Kbd } from "@/components/_ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/_ui/select";
import Markdown from "@/components/assistant/markdown";
import MentionInput from "@/components/assistant/mention-input";
import { AttachButton, AttachmentList, fileSize, useEmailAttachments } from "@/components/crm/email-attachments";
import { useScreenState } from "@/components/crm/quick-add";
import { useShortcut, useShortcuts } from "@/components/shortcuts/shortcuts-provider";
import {
  chatDefaultsAction,
  deleteConversationAction,
  discardChatFilesAction,
  getConversationAction,
  listConversationsAction,
  openBriefAction,
  prepareChatFileAction,
  stopConversationAction,
} from "@/app/(crm)/assistant";
import type { ActionDecision, AssistantAction, AssistantEvent, ConversationSummary, DisplayMessage, Working } from "@/lib/assistant/chat";
import {
  ASSISTANT_MODELS,
  DEFAULT_MODEL,
  MODEL_SOURCES,
  DEFAULT_REASONING,
  REASONING_LABELS,
  assistantModel,
  availableModels,
  settingsFor,
  startingSettings,
  type ModelSource,
  type ReasoningLevel,
} from "@/lib/assistant/models";
import { relativeWhen } from "@/lib/companies";
import { pageHref } from "@/lib/docs/routes";
import type { DocDiffLine } from "@/lib/docs/types";
import type { UnreadBrief } from "@/lib/learning/nightly";
import { briefKey, opensBriefOnExpand, pendingBrief as unhandledBrief } from "@/lib/assistant/brief-dock";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { encodeMentions, liveMentions, splitMentions, type Mention } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import { useDocsStore } from "@/stores/docs-store";
import { pageSnapshot } from "@/stores/page-context-store";
import ArrowUpIcon from "@/public/assets/images/assistant/arrow-up.svg";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import CopyIcon from "@/public/assets/images/assistant/copy.svg";
import GlobeIcon from "@/public/assets/images/assistant/globe.svg";
import StopIcon from "@/public/assets/images/assistant/stop.svg";
import TrashIcon from "@/public/assets/images/assistant/trash.svg";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import ClockIcon from "@/public/assets/images/companies/detail/clock.svg";

const SETTINGS_KEY = "orbit-assistant-settings";
const CONVERSATION_KEY = "orbit-assistant-conversation";
const CHAT_PARAM = "chat";

type LiveTool = { id: string; label: string; status: "running" | "done" };

type Unsent = { typed: string; mentions: Mention[]; files: DisplayMessage["files"] };

const STARTERS: { match: RegExp; prompts: string[] }[] = [
  { match: /^\/mail/, prompts: ["What needs a reply from me today?", "Summarise what customers emailed this week", "Draft a follow-up to anyone who hasn't replied"] },
  { match: /^\/companies\/|^\/contacts\//, prompts: ["Summarise where we are with them", "What should my next step be?", "Draft a check-in email"] },
  { match: /^\/opportunities/, prompts: ["Which deals need attention this week?", "What's likely to close this month?", "Which deals have gone quiet?"] },
  { match: /^\/tasks/, prompts: ["What's overdue, and what should I do first?", "Plan my day from my tasks and meetings", "Which tasks can wait?"] },
  { match: /^\/calendar/, prompts: ["Prepare me for my next meeting", "Who am I meeting this week, and what do I need to know?", "Find time for a call next week"] },
  { match: /.*/, prompts: ["What should I focus on today?", "Which relationships are cooling?", "Summarise this morning's brief"] },
];

const CHAT_UPLOADS = { prepare: prepareChatFileAction, discard: discardChatFilesAction };

const FOLLOW_MS = 30 * 60_000;
const FOLLOW_EVERY_MS = 5_000;

function workingText(working: Working) {
  const steps = working.steps === 1 ? "1 step" : `${working.steps} steps`;
  const now = working.current ? ` · ${working.current}` : "";
  return working.where === "mac" ? `Working on your Mac · ${steps}${now}` : `Working · ${steps}`;
}

function readSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Record<string, unknown>;
    const settings = settingsFor(parsed.model, parsed.reasoning);
    return { ...settings, webSearch: parsed.webSearch === true, saved: { model: parsed.model, reasoning: parsed.reasoning } };
  } catch {
    return { model: DEFAULT_MODEL, reasoning: DEFAULT_REASONING, webSearch: false, saved: null };
  }
}

async function streamAssistant(body: Record<string, unknown>, onEvent: (event: AssistantEvent) => void, signal: AbortSignal) {
  const response = await fetch("/api/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? "The assistant is unavailable right now.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(JSON.parse(line) as AssistantEvent);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
}

const ACTION_STATUS: Record<AssistantAction["status"], string> = {
  pending: "Waiting for you",
  running: "Working…",
  done: "Done",
  failed: "Failed",
  declined: "Cancelled",
};

const GROUP_PREVIEW = 5;

type Decide = (decisions: ActionDecision[]) => void;

function statusTone(status: AssistantAction["status"]) {
  return cn(
    status === "done" && "text-success",
    status === "failed" && "text-danger",
    status === "pending" && "text-warning",
    (status === "declined" || status === "running") && "text-subtle",
  );
}

function groupStatus(actions: AssistantAction[]) {
  if (actions.some((action) => action.status === "pending")) return { label: ACTION_STATUS.pending, tone: statusTone("pending") };
  if (actions.some((action) => action.status === "running")) return { label: ACTION_STATUS.running, tone: statusTone("running") };
  const count = (status: AssistantAction["status"]) => actions.filter((action) => action.status === status).length;
  const parts = [
    count("done") && `${count("done")} done`,
    count("failed") && `${count("failed")} failed`,
    count("declined") && `${count("declined")} cancelled`,
  ].filter(Boolean);
  const tone = count("failed") ? statusTone("failed") : count("done") ? statusTone("done") : statusTone("declined");
  return { label: parts.join(", "), tone };
}

function statusLabel(action: AssistantAction) {
  return action.status === "done" && action.chose === "send" ? "Sent" : ACTION_STATUS[action.status];
}

function DiffBlock({ lines }: { lines: DocDiffLine[] }) {
  const added = lines.filter((line) => line.kind === "add").length;
  const removed = lines.filter((line) => line.kind === "remove").length;
  const summary = [added && `${added} ${added === 1 ? "line" : "lines"} added`, removed && `${removed} removed`].filter(Boolean).join(", ") || "No text changes";
  return (
    <div className="flex flex-col">
      <ol
        aria-label={`Changes to the doc: ${summary}`}
        tabIndex={0}
        className="focus-visible:ring-ring/60 max-h-64 overflow-y-auto rounded-xl bg-black/25 py-1.5 text-[13px] leading-[1.55] outline-none focus-visible:ring-2"
      >
        {lines.map((line, index) => (
          <li
            key={index}
            className={cn(
              "grid grid-cols-[1.5rem_1fr] pr-3",
              line.kind === "add" && "bg-(--tag-green-bg)/70 text-(--tag-green-text)",
              line.kind === "remove" && "bg-(--tag-red-bg)/70 text-(--tag-red-text)",
              line.kind === "same" && "text-subtle",
              line.kind === "gap" && "text-faint",
            )}
          >
            <span aria-hidden className="text-center select-none">
              {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}
            </span>
            <span className="min-w-0 break-words whitespace-pre-wrap">
              {line.kind === "add" && <span className="sr-only">Added: </span>}
              {line.kind === "remove" && <span className="sr-only">Removed: </span>}
              {line.kind === "gap" ? line.text || "…" : line.text || " "}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ActionLines({ action }: { action: AssistantAction }) {
  return (
    <>
      {action.diff && action.diff.length > 0 && <DiffBlock lines={action.diff} />}
      {action.lines.length > 0 && (
        <ul className="text-soft flex flex-col gap-0.5 text-[13px] leading-5">
          {action.lines.map((line, index) => (
            <li key={index} className="break-words whitespace-pre-wrap">
              {line}
            </li>
          ))}
        </ul>
      )}
      {action.status === "failed" && action.result && <p className="caption-style text-danger">{action.result}</p>}
    </>
  );
}

function ActionCard({ action, busy, onDecide }: { action: AssistantAction; busy: boolean; onDecide: Decide }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-white/[0.04] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <span className="text-foreground min-w-0 text-[13.5px] leading-5 font-medium">{action.title}</span>
        <span className="flex shrink-0 items-center gap-2">
          {action.unattended && <UnattendedMark />}
          <span className={cn("caption-style", statusTone(action.status))}>{statusLabel(action)}</span>
        </span>
      </div>
      <ActionLines action={action} />
      {action.status === "pending" && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => onDecide([{ id: action.id, approve: true }])}>
            Confirm
          </Button>
          {action.alternative && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => onDecide([{ id: action.id, approve: true, variant: action.alternative!.key }])}>
              {action.alternative.label}
            </Button>
          )}
          {action.docId && (
            <Button variant="secondary" size="sm" href={pageHref(action.docId)}>
              Open in Docs
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDecide([{ id: action.id, approve: false }])}>
            Cancel
          </Button>
          {action.diff && <span className="caption-style text-subtle ml-auto">You can undo this from versions</span>}
        </div>
      )}
      {action.status === "done" && action.docId && (
        <div className="flex pt-1">
          <Button variant="secondary" size="sm" href={pageHref(action.docId)}>
            Open in Docs
          </Button>
        </div>
      )}
    </div>
  );
}

const MARK_CLASS = "caption-style rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[#c9c2ff]";

function UnattendedMark() {
  return (
    <span className={MARK_CLASS}>
      Edited without asking
    </span>
  );
}

function ActionGroup({ actions, busy, onDecide }: { actions: AssistantAction[]; busy: boolean; onDecide: Decide }) {
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [sending, setSending] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState(false);
  const pending = actions.filter((action) => action.status === "pending");
  const chosen = pending.filter((action) => !skipped.has(action.id));
  const status = groupStatus(actions);
  const shown = expanded ? actions : actions.slice(0, GROUP_PREVIEW);

  function toggle(id: string) {
    setSkipped((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function decideAll(approve: boolean) {
    onDecide(
      pending.map((action) => {
        const approved = approve && !skipped.has(action.id);
        return approved && action.alternative && sending.has(action.id) ? { id: action.id, approve: true, variant: action.alternative.key } : { id: action.id, approve: approved };
      }),
    );
  }

  function toggleSend(id: string) {
    setSending((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-white/[0.04] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <span className="text-foreground text-[13.5px] leading-5 font-medium">{actions.length} changes</span>
        <span className={cn("caption-style shrink-0", status.tone)}>{status.label}</span>
      </div>
      <ul className="flex flex-col gap-2.5">
        {shown.map((action) => {
          const waiting = action.status === "pending";
          const included = waiting && !skipped.has(action.id);
          return (
            <li key={action.id} className="flex items-start gap-2.5">
              {waiting ? (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={included}
                  aria-label={included ? `Skip ${action.title}` : `Include ${action.title}`}
                  disabled={busy}
                  onClick={() => toggle(action.id)}
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-150",
                    included ? "border-primary bg-primary text-white" : "border-white/20 bg-transparent",
                  )}
                >
                  {included && <CheckIcon className="size-3" aria-hidden />}
                </button>
              ) : null}
              <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", waiting && !included && "opacity-50")}>
                <div className="flex items-start justify-between gap-3">
                  <span className="text-foreground min-w-0 text-[13px] leading-5">{action.title}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {action.unattended && <UnattendedMark />}
                    {!waiting && <span className={cn("caption-style", statusTone(action.status))}>{statusLabel(action)}</span>}
                  </span>
                </div>
                <ActionLines action={action} />
                {waiting && included && action.alternative && (
                  <label className="caption-style text-soft mt-1 flex cursor-pointer items-center gap-2 self-start">
                    <input
                      type="checkbox"
                      checked={sending.has(action.id)}
                      disabled={busy}
                      onChange={() => toggleSend(action.id)}
                      className="accent-primary size-3.5"
                    />
                    Send now instead
                  </label>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {actions.length > GROUP_PREVIEW && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="caption-style text-subtle hover:text-foreground self-start transition-colors duration-150"
        >
          {expanded ? "Show fewer" : `Show all ${actions.length}`}
        </button>
      )}
      {pending.length > 0 && (
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" disabled={busy || chosen.length === 0} onClick={() => decideAll(true)}>
            {chosen.length === pending.length ? "Confirm all" : `Confirm ${chosen.length}, cancel ${pending.length - chosen.length}`}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => decideAll(false)}>
            Cancel all
          </Button>
        </div>
      )}
    </div>
  );
}

type Shown = { key: string; message: DisplayMessage } | { key: string; tools: DisplayMessage["tools"] };

function visible(message: DisplayMessage) {
  return message.role === "user" || Boolean(message.content) || message.sources.length > 0 || message.actions.length > 0;
}

function shownItems(messages: DisplayMessage[], busy: boolean): Shown[] {
  const segments: DisplayMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" || segments.length === 0) segments.push([message]);
    else segments[segments.length - 1].push(message);
  }
  return segments.flatMap((segment, index) => {
    const [first, ...rest] = segment;
    const lead = first.role === "user" ? [first] : [];
    const replies = first.role === "user" ? rest : segment;
    const tools = replies.flatMap((message) => message.tools);
    const live = busy && index === segments.length - 1;
    return [
      ...lead.map((message) => ({ key: message.id, message })),
      ...(tools.length > 0 && !live ? [{ key: `tools-${first.id}`, tools }] : []),
      ...replies.filter(visible).map((message) => ({ key: message.id, message })),
    ];
  });
}

function ToolTrail({ tools }: { tools: DisplayMessage["tools"] }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        variant="ghost"
        size="none"
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((value) => !value)}
        className="caption-style -ml-1.5 gap-1 rounded-md px-1.5 py-1"
      >
        Tool use · {tools.length}
        <ChevronDownIcon aria-hidden className={cn("size-3 transition-transform duration-150 ease-power3-out", open && "rotate-180")} />
      </Button>
      {open && (
        <div id={panel} className="w-full rounded-xl border border-dashed border-white/15 px-3 py-2">
          <ol aria-label="Tool use" className="flex max-h-48 flex-col gap-1 overflow-y-auto overscroll-contain">
            {tools.map((tool, index) => (
              <li key={`${tool.id}-${index}`} className="text-subtle flex min-h-[18px] shrink-0 items-center gap-2 text-[12px] leading-[18px]">
                <span aria-hidden className="bg-faint size-1.5 shrink-0 rounded-full" />
                <span className="truncate">{tool.label}</span>
                <span className="text-faint shrink-0">✓</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function LiveSteps({ tools, thinking }: { tools: LiveTool[]; thinking: boolean }) {
  const list = useRef<HTMLOListElement>(null);
  const rows = tools.length + (thinking ? 1 : 0);

  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollTo({ top: node.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [rows, tools]);

  return (
    <div className="rounded-xl border border-dashed border-white/15 px-3 py-2" aria-live="polite">
      <span className="text-subtle font-mono text-[10.5px] leading-4 tracking-[0.08em] uppercase">
        Working{tools.length > 0 ? ` · ${tools.length}` : ""}
      </span>
      <ol
        ref={list}
        aria-label="Steps so far"
        className="mt-1.5 flex max-h-[62px] flex-col gap-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {rows > 3 && <li aria-hidden className="pointer-events-none sticky top-0 z-10 -mb-[18px] h-3.5 shrink-0 bg-gradient-to-b from-[#1c1c1c] to-transparent" />}
        {tools.map((tool) => (
          <li key={tool.id} className="text-subtle flex min-h-[18px] shrink-0 items-center gap-2 text-[12px] leading-[18px]">
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tool.status === "running" ? "bg-soft animate-pulse" : "bg-faint")} />
            <span className="truncate">{tool.label}</span>
            <span className="text-faint shrink-0">{tool.status === "done" ? "✓" : "…"}</span>
          </li>
        ))}
        {thinking && (
          <li className="text-subtle flex min-h-[18px] shrink-0 items-center gap-2 text-[12px] leading-[18px]">
            <span aria-hidden className="bg-soft size-1.5 shrink-0 animate-pulse rounded-full" />
            Thinking…
          </li>
        )}
      </ol>
    </div>
  );
}

function CopyableReply({ text }: { text: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    const plain = body.current?.innerText.trim() || text;
    try {
      await navigator.clipboard.writeText(plain);
      setCopied(true);
    } catch {}
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div ref={body}>
        <Markdown text={text} />
      </div>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "Copied" : "Copy reply"}
        title={copied ? "Copied" : "Copy"}
        className="text-subtle hover:text-foreground focus-visible:ring-ring/60 ease-power3-out -ml-1.5 flex size-7 cursor-pointer items-center justify-center rounded-full transition-colors duration-150 outline-none hover:bg-white/5 focus-visible:ring-2"
      >
        {copied ? <CheckIcon aria-hidden className="text-soft size-3.5" /> : <CopyIcon aria-hidden className="size-3.5" />}
      </button>
    </div>
  );
}

function Message({
  message,
  busy,
  onDecide,
}: {
  message: DisplayMessage;
  busy: boolean;
  onDecide: Decide;
}) {
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {message.files.length > 0 && (
          <ul aria-label="Attached files" className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {message.files.map((file) => (
              <li key={file.id} className="text-soft flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full bg-white/[0.07] px-2.5 text-[13px] leading-5">
                <PaperclipIcon aria-hidden className="size-3 shrink-0" />
                <span className="min-w-0 truncate">{file.name}</span>
                <span className="caption-style text-subtle shrink-0">{fileSize(file.size)}</span>
              </li>
            ))}
          </ul>
        )}
        {message.content && (
          <div className="text-foreground max-w-[85%] min-w-0 rounded-2xl rounded-br-md bg-white/[0.07] px-3.5 py-2 text-[14px] leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {splitMentions(message.content).map((piece, index) =>
              "mention" in piece ? <MentionChip key={index} mention={piece.mention} /> : <span key={index}>{piece.text}</span>,
            )}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      {message.content && <CopyableReply text={message.content} />}
      {message.sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {message.sources.map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="caption-style text-subtle hover:text-foreground max-w-[16rem] truncate rounded-full bg-white/[0.04] px-2 py-0.5"
            >
              {source.title || new URL(source.url).hostname}
            </a>
          ))}
        </div>
      )}
      {message.actions.length === 1 && <ActionCard action={message.actions[0]} busy={busy} onDecide={onDecide} />}
      {message.actions.length > 1 && <ActionGroup actions={message.actions} busy={busy} onDecide={onDecide} />}
    </div>
  );
}

function MentionChip({ mention }: { mention: Mention }) {
  const href =
    mention.kind === "contact"
      ? contactHref(mention.id)
      : mention.kind === "company"
        ? companyHref(mention.id)
        : mention.kind === "task"
          ? "/tasks"
          : mention.kind === "proposal"
            ? `/proposals/${mention.id}`
            : "/opportunities";
  return (
    <a
      href={href}
      className="rounded-[4px] bg-[var(--tag-purple-bg)] text-[var(--tag-purple-text)] shadow-[0_0_0_2px_var(--tag-purple-bg)] hover:underline"
    >
      @{mention.name}
    </a>
  );
}

function WorkspaceChip({ id, name }: { id: string; name: string }) {
  return (
    <span title={`Working in ${name}`} className="text-soft flex h-[22px] max-w-[45%] shrink-0 items-center gap-1.5 rounded-full bg-white/[0.05] pr-2 pl-[3px] text-[12px] leading-none">
      <WorkspaceTile id={id} name={name} className="size-4 rounded-full text-[9px]" />
      <span className="truncate">
        <span className="sr-only">Working in </span>
        {name}
      </span>
    </span>
  );
}

export default function AssistantDock({ brief = null, workspaceName = "", workspaceId = "" }: { brief?: UnreadBrief | null; workspaceName?: string; workspaceId?: string }) {
  const where = workspaceName.trim();
  const askLabel = where ? `Ask Orbit in ${where}` : "Ask Orbit anything";
  const router = useRouter();
  const pathname = usePathname();
  const { mac } = useShortcuts();
  const { covered, lift } = useScreenState();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [reasoning, setReasoning] = useState<ReasoningLevel>(DEFAULT_REASONING);
  const [webSearch, setWebSearch] = useState(false);
  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [live, setLive] = useState<LiveTool[]>([]);
  const [streamed, setStreamed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [working, setWorking] = useState<Working | null>(null);
  const [history, setHistory] = useState<ConversationSummary[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [handledBrief, setHandledBrief] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const changed = useRef(false);
  const conversationId = useRef<string | null>(null);
  const modelChosen = useRef(false);
  const defaultsLoaded = useRef(false);
  const settingsRead = useRef(false);
  const pinned = useRef(true);
  const waiting = useRef(false);
  const recovering = useRef(0);
  const view = useRef(0);
  const streams = useRef(new Set<AbortController>());
  const steerQueue = useRef<Promise<void>>(Promise.resolve());
  const pickedUp = useRef(new Set<string>());
  const shownMessages = useRef<DisplayMessage[]>([]);
  const resumedFor = useRef<string | null>(null);
  const steerEpoch = useRef(0);
  const steerCount = useRef(0);
  const unsent = useRef(new Map<string, Unsent>());
  const [connected, setConnected] = useState<ModelSource[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const files = useEmailAttachments([], CHAT_UPLOADS);

  const applyDefaults = useCallback(async () => {
    const saved = readSettings().saved;
    const defaults = await chatDefaultsAction().catch(() => null);
    defaultsLoaded.current = true;
    if (defaults?.connected) setConnected(defaults.connected);
    if (modelChosen.current) return;
    const next = startingSettings([defaults?.last, saved], defaults?.connected ?? undefined);
    setModel(next.model);
    setReasoning(next.reasoning);
  }, []);

  const follow = useCallback(
    async (id: string): Promise<DisplayMessage[] | null> => {
      const token = ++recovering.current;
      const started = Date.now();
      while (Date.now() - started < FOLLOW_MS) {
        await new Promise((resolve) => window.setTimeout(resolve, FOLLOW_EVERY_MS));
        if (conversationId.current !== id || recovering.current !== token) return null;
        const result = await getConversationAction(id).catch(() => null);
        if (!result || conversationId.current !== id || recovering.current !== token) continue;
        setMessages(result.messages);
        setWorking(result.working);
        if (!result.working) {
          setNotice(null);
          router.refresh();
          return result.messages;
        }
      }
      return null;
    },
    [router],
  );

  useEffect(() => {
    if (!settingsRead.current) return;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ model, reasoning, webSearch }));
    } catch {}
  }, [model, reasoning, webSearch]);

  useEffect(() => {
    conversationId.current = conversation?.id ?? null;
    try {
      if (conversation) sessionStorage.setItem(CONVERSATION_KEY, conversation.id);
      else sessionStorage.removeItem(CONVERSATION_KEY);
    } catch {}
  }, [conversation]);

  useEffect(() => {
    shownMessages.current = messages;
  }, [messages]);

  useEffect(() => {
    const node = scroller.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [messages, live, busy, error, streamed]);

  useEffect(() => {
    const node = scroller.current;
    if (!node || !open) return;
    pinned.current = true;
    node.scrollTop = node.scrollHeight;
  }, [open]);

  useEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [draft, open]);

  useShortcut(
    "back",
    () => {
      setOpen(false);
      setHistoryOpen(false);
    },
    open,
  );

  const onEvent = useCallback((event: AssistantEvent) => {
    if (event.type === "conversation") {
      conversationId.current = event.conversation.id;
      setConversation(event.conversation);
    }
    if (event.type === "user") {
      const saved = pickedUp.current.has(event.message.id) ? { ...event.message, waiting: false } : event.message;
      setMessages((current) => {
        if (current.some((message) => message.id === saved.id)) return current;
        if (!event.message.waiting) return [...current.filter((message) => !message.id.startsWith("local-") || message.waiting), saved];
        const local = current.findIndex((message) => message.id.startsWith("local-") && message.waiting);
        return [...current.filter((_, index) => index !== local), saved];
      });
    }
    if (event.type === "steered") {
      const ids = new Set(event.ids);
      for (const id of event.ids) pickedUp.current.add(id);
      setMessages((current) => {
        const moved = current.filter((message) => ids.has(message.id)).map((message) => ({ ...message, waiting: false }));
        return moved.length > 0 ? [...current.filter((message) => !ids.has(message.id)), ...moved] : current;
      });
    }
    if (event.type === "tool") {
      setLive((current) => {
        const others = current.filter((tool) => tool.id !== event.id);
        return [...others, { id: event.id, label: event.label, status: event.status }];
      });
    }
    if (event.type === "draft") setStreamed(event.text);
    if (event.type === "message" || event.type === "actions" || event.type === "error") setStreamed(null);
    if (event.type === "message") {
      setLive([]);
      setMessages((current) => {
        const index = current.findIndex((message) => message.id === event.message.id);
        if (index < 0) return [...current, event.message];
        const next = current.slice();
        next[index] = { ...event.message, tools: event.message.tools.length ? event.message.tools : next[index].tools };
        return next;
      });
    }
    if (event.type === "actions") {
      setLive([]);
      if (event.actions.some((action) => action.status === "done")) changed.current = true;
      if (event.actions.some((action) => action.status === "done" && action.name === "save_doc")) useDocsStore.getState().refreshAfterAgent();
      setMessages((current) => {
        const index = current.findIndex((message) => message.id === event.messageId);
        if (index < 0) {
          return [
            ...current,
            { id: event.messageId, role: "assistant", content: "", tools: [], actions: event.actions, sources: [], files: [], createdAt: new Date().toISOString() },
          ];
        }
        const next = current.slice();
        next[index] = { ...next[index], actions: event.actions };
        return next;
      });
    }
    if (event.type === "error") setError(event.message);
    if (event.type === "waiting") {
      waiting.current = true;
      setNotice(event.message);
    }
  }, []);

  function abortStreams() {
    for (const controller of streams.current) controller.abort();
    streams.current.clear();
  }

  function detach() {
    view.current += 1;
    abortStreams();
    recovering.current += 1;
    waiting.current = false;
    setBusy(false);
    setStreamed(null);
    setLive([]);
    return view.current;
  }

  function resumeWaiting(list: DisplayMessage[], id: string | null) {
    const held = list.filter((message) => message.waiting && !message.id.startsWith("local-"));
    if (!id || held.length === 0 || list.some((message) => message.actions.some((action) => action.status === "pending" || action.status === "running"))) return;
    const key = held.map((message) => message.id).join(",");
    if (resumedFor.current === key) return;
    resumedFor.current = key;
    void run({ conversationId: id, resume: true });
  }

  async function stream(body: Record<string, unknown>, mine: number, kind: "run" | "steer", onSaved?: (saved: boolean, reason?: string) => void) {
    const current = () => view.current === mine;
    const controller = new AbortController();
    streams.current.add(controller);
    setBusy(true);
    let clean = true;
    let echoed = false;
    let reason: string | undefined;
    try {
      await streamAssistant(
        body,
        (event) => {
          if (!current()) return;
          if (event.type === "error") clean = false;
          if (event.type === "error" && kind === "steer" && !echoed) {
            reason = event.message;
            return;
          }
          onEvent(event);
          if (event.type === "user") {
            echoed = true;
            onSaved?.(true);
          }
        },
        controller.signal,
      );
    } catch (caught) {
      clean = false;
      if (kind === "steer" && !(caught instanceof TypeError) && caught instanceof Error && caught.name !== "AbortError") reason = caught.message;
      if (current() && kind === "run" && !(caught instanceof Error && caught.name === "AbortError")) {
        const dropped = caught instanceof TypeError;
        if (dropped && conversationId.current) {
          setNotice("Connection lost. Still working.");
          const id = conversationId.current;
          void follow(id).then((list) => list && resumeWaiting(list, id));
        } else {
          setError(caught instanceof Error ? caught.message : "The assistant is unavailable right now.");
        }
      }
    } finally {
      onSaved?.(false, reason);
      streams.current.delete(controller);
      if (!clean && body.resume) resumedFor.current = null;
      const last = streams.current.size === 0;
      if (current() && last) {
        setBusy(false);
        setLive([]);
        setStreamed(null);
      }
      if (current() && last && kind === "run" && waiting.current && conversationId.current) {
        waiting.current = false;
        const id = conversationId.current;
        void follow(id).then((list) => list && resumeWaiting(list, id));
      } else if (current() && last && kind === "run" && clean) {
        resumeWaiting(shownMessages.current, conversationId.current);
      }
      if (changed.current) {
        changed.current = false;
        router.refresh();
      }
    }
  }

  async function run(body: Record<string, unknown>) {
    const mine = ++view.current;
    setBusy(true);
    recovering.current += 1;
    setWorking(null);
    setError(null);
    setNotice(null);
    setLive([]);
    setStreamed(null);
    await stream(body, mine, "run");
  }

  function putBack(entries: Unsent[]) {
    if (entries.length === 0) return;
    setDraft((current) => [...entries.map((entry) => entry.typed), current].filter((text) => text.trim()).join("\n\n"));
    setMentions((current) => [...entries.flatMap((entry) => entry.mentions), ...current]);
    files.restore(entries.flatMap((entry) => entry.files));
  }

  function steer(entry: Unsent, message: string) {
    const id = conversationId.current;
    if (!id) return;
    const mine = view.current;
    const epoch = steerEpoch.current;
    steerCount.current += 1;
    const local = `local-steer-${steerCount.current}`;
    unsent.current.set(local, entry);
    setMessages((current) => [
      ...current,
      { id: local, role: "user", content: message, tools: [], actions: [], sources: [], files: entry.files, createdAt: new Date().toISOString(), waiting: true },
    ]);
    const body = { conversationId: id, message, files: entry.files.map((file) => file.id), page: pageSnapshot(), steer: true };
    const dropLocal = () => setMessages((current) => current.filter((item) => item.id !== local));
    steerQueue.current = steerQueue.current.then(
      () =>
        new Promise<void>((resolve) => {
          if (view.current !== mine || steerEpoch.current !== epoch) {
            resolve();
            return;
          }
          let settled = false;
          void stream(body, mine, "steer", (saved, reason) => {
            if (settled) return;
            settled = true;
            const held = unsent.current.get(local);
            unsent.current.delete(local);
            if (saved) {
              setMessages((current) => {
                const index = current.findIndex((item) => item.id === local);
                return index < 0 ? current : current.filter((_, position) => position !== index);
              });
            } else if (view.current === mine && steerEpoch.current === epoch && held) {
              dropLocal();
              putBack([held]);
              setError(`${reason ? `${reason} ` : ""}That message wasn't sent. It's back in the message box.`);
            }
            resolve();
          });
        }),
    );
  }

  function send(text: string) {
    const typed = text.trim();
    const attached = files.files;
    const steering = busy || Boolean(working);
    if ((!typed && attached.length === 0) || files.uploading || (steering && !conversationId.current)) return;
    const message = typed ? encodeMentions(typed, liveMentions(typed, mentions)) : "";
    pinned.current = true;
    setDraft("");
    setMentions([]);
    files.clear();
    if (steering) {
      setError(null);
      steer({ typed, mentions: liveMentions(typed, mentions), files: attached }, message);
      return;
    }
    setMessages((current) => [
      ...current,
      { id: `local-${Date.now()}`, role: "user", content: message, tools: [], actions: [], sources: [], files: attached, createdAt: new Date().toISOString() },
    ]);
    void run({
      conversationId: conversation?.id ?? null,
      message,
      model: active.model,
      reasoning: active.reasoning,
      webSearch,
      files: attached.map((file) => file.id),
      page: pageSnapshot(),
    });
  }

  const resumeOnLoad = useEffectEvent((list: DisplayMessage[], id: string) => resumeWaiting(list, id));

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = readSettings();
      settingsRead.current = true;
      setModel(saved.model);
      setReasoning(saved.reasoning);
      setWebSearch(saved.webSearch);
      const url = new URL(window.location.href);
      const linked = url.searchParams.get(CHAT_PARAM);
      if (linked) {
        url.searchParams.delete(CHAT_PARAM);
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
      if (linked) modelChosen.current = true;
      void applyDefaults();
      const last = linked ?? sessionStorage.getItem(CONVERSATION_KEY);
      if (last) {
        const mine = view.current;
        void getConversationAction(last).then((result) => {
          if (view.current !== mine) return;
          if (!result) {
            if (linked) {
              setOpen(true);
              setError("That chat couldn't be opened.");
            }
            return;
          }
          setConversation(result.conversation);
          setMessages(result.messages);
          setWorking(result.working);
          if (!result.working) resumeOnLoad(result.messages, result.conversation.id);
          if (linked) {
            const settings = settingsFor(result.conversation.model, result.conversation.reasoning);
            setModel(settings.model);
            setReasoning(settings.reasoning);
            setWebSearch(result.conversation.webSearch);
            setOpen(true);
          }
          if (result.working) void follow(result.conversation.id).then((list) => list && resumeOnLoad(list, result.conversation.id));
        });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [follow, applyDefaults]);

  function carriesFiles(event: DragEvent) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function dragOver(event: DragEvent) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!dragging) setDragging(true);
  }

  function dragLeave(event: DragEvent) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
  }

  function drop(event: DragEvent) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length > 0) void files.add(dropped);
  }

  function decide(decisions: ActionDecision[]) {
    if (!conversation || busy || decisions.length === 0) return;
    void run({ conversationId: conversation.id, decisions });
  }

  function stopTurn() {
    steerEpoch.current += 1;
    steerQueue.current = Promise.resolve();
    abortStreams();
    recovering.current += 1;
    waiting.current = false;
    setNotice(null);
    const queued = shownMessages.current.filter((message) => message.waiting && message.id.startsWith("local-"));
    putBack(queued.flatMap((message) => unsent.current.get(message.id) ?? []));
    unsent.current.clear();
    setMessages((current) =>
      current.filter((message) => !(message.waiting && message.id.startsWith("local-"))).map((message) => (message.waiting ? { ...message, waiting: false } : message)),
    );
    if (conversationId.current) void stopConversationAction(conversationId.current);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    send(draft);
  }

  function newChat() {
    detach();
    if (conversation) {
      modelChosen.current = false;
      void applyDefaults();
    }
    setWorking(null);
    setConversation(null);
    setMessages([]);
    setLive([]);
    setError(null);
    setNotice(null);
    setHistoryOpen(false);
    window.requestAnimationFrame(() => input.current?.focus());
  }

  async function openHistory(next: boolean) {
    setHistoryOpen(next);
    if (next) setHistory(await listConversationsAction());
  }

  async function load(id: string) {
    setHistoryOpen(false);
    pinned.current = true;
    const mine = detach();
    const result = await getConversationAction(id);
    if (view.current !== mine) return;
    if (!result) {
      setError("That chat couldn't be opened.");
      return;
    }
    setConversation(result.conversation);
    setMessages(result.messages);
    setWorking(result.working);
    if (result.working) void follow(result.conversation.id).then((list) => list && resumeWaiting(list, result.conversation.id));
    else {
      recovering.current += 1;
      resumeWaiting(result.messages, result.conversation.id);
    }
    const settings = settingsFor(result.conversation.model, result.conversation.reasoning);
    modelChosen.current = true;
    setModel(settings.model);
    setReasoning(settings.reasoning);
    setWebSearch(result.conversation.webSearch);
    setError(null);
    setNotice(null);
  }

  const pendingBrief = unhandledBrief(brief, handledBrief);
  const cardsWaiting = messages.some((message) => message.actions.some((action) => action.status === "pending"));
  const canSend = Boolean(draft.trim() || files.ids.length > 0) && !files.uploading;

  function expand() {
    setOpen(true);
    if (pendingBrief && opensBriefOnExpand({ pending: true, busy, working: Boolean(working), messages: messages.length })) void showBrief(pendingBrief);
    else window.requestAnimationFrame(() => input.current?.focus());
  }

  async function showBrief(next: UnreadBrief) {
    setHandledBrief(briefKey(next));
    setHistoryOpen(false);
    pinned.current = true;
    const mine = detach();
    const chosen = defaultsLoaded.current || modelChosen.current ? { model: active.model, reasoning: active.reasoning } : {};
    const result = await openBriefAction(next.id, { ...chosen, webSearch });
    if (view.current !== mine) return;
    if (!result.opened) {
      setHandledBrief(null);
      setError(result.error ?? "Couldn't open your brief. Try again.");
      return;
    }
    const settings = settingsFor(result.opened.conversation.model, result.opened.conversation.reasoning);
    modelChosen.current = true;
    setModel(settings.model);
    setReasoning(settings.reasoning);
    setConversation(result.opened.conversation);
    setMessages(result.opened.messages);
    setWorking(null);
    recovering.current += 1;
    setError(null);
    setNotice(null);
    window.requestAnimationFrame(() => input.current?.focus());
  }

  useShortcut("assistant", () => expand());

  async function remove(id: string) {
    const result = await deleteConversationAction(id);
    if (result.error) {
      setError(result.error);
      return;
    }
    setHistory((current) => current?.filter((item) => item.id !== id) ?? null);
    if (conversation?.id === id) newChat();
  }

  const active = connected ? settingsFor(model, reasoning, connected) : { model, reasoning };
  const chosen = assistantModel(active.model) ?? ASSISTANT_MODELS[0];
  const offered = availableModels(connected ?? (chosen.source === "orbit" ? [] : [chosen.source]));
  const groups = MODEL_SOURCES.map((source) => ({ ...source, models: offered.filter((option) => option.source === source.id) })).filter(
    (group) => group.models.length > 0,
  );
  const position = {
    "--assistant-lift": `${lift}px`,
  } as CSSProperties;
  const placement =
    "fixed z-40 bottom-[max(calc(env(safe-area-inset-bottom)+1rem),var(--assistant-lift))] left-3 right-[4.75rem] md:right-auto md:left-1/2 md:-translate-x-1/2 lg:left-[calc(var(--sidebar-width)+(100vw-var(--sidebar-width))/2)] sidebar-collapsed:lg:left-1/2";

  if (!open) {
    return (
      <div style={position} className={cn(placement, "transition-[bottom] duration-200 ease-power3-out", covered && "invisible")}>
        <button
          type="button"
          onClick={expand}
          aria-keyshortcuts="o"
          className="group text-subtle hover:text-foreground focus-visible:ring-ring/60 ease-power3-out flex h-11 w-full cursor-text items-center gap-2.5 rounded-full bg-[#1f1f1f]/90 pr-2 pl-5 text-left text-[14px] shadow-[0_12px_40px_rgba(0,0,0,0.5)] backdrop-blur-xl transition-[color,background-color] duration-150 outline-none hover:bg-[#232323]/95 focus-visible:ring-2 md:w-[24rem]"
        >
          {pendingBrief && <span aria-hidden className="bg-primary -ml-1 size-2 shrink-0 rounded-full" />}
          <span className="min-w-0 flex-1 truncate">{messages.length > 0 ? conversation?.title ?? "Continue your chat" : askLabel}</span>
          {pendingBrief && <span className="sr-only">Your morning brief is ready</span>}
          <Kbd aria-hidden className="max-md:hidden">
            O
          </Kbd>
        </button>
      </div>
    );
  }

  return (
    <div
      style={position}
      className={cn(
        "fixed z-40 inset-x-2 top-16 bottom-[max(calc(env(safe-area-inset-bottom)+0.5rem),var(--assistant-lift))] md:inset-x-auto md:top-auto md:bottom-[max(calc(env(safe-area-inset-bottom)+1rem),var(--assistant-lift))] md:left-1/2 md:w-[min(46rem,calc(100vw-2rem))] md:-translate-x-1/2 lg:left-[calc(var(--sidebar-width)+(100vw-var(--sidebar-width))/2)] lg:w-[min(46rem,calc(100vw-var(--sidebar-width)-3rem))] sidebar-collapsed:lg:left-1/2",
        covered && "invisible",
      )}
    >
      <section
        aria-label="Orbit assistant"
        onDragEnter={dragOver}
        onDragOver={dragOver}
        onDragLeave={dragLeave}
        onDrop={drop}
        className="animate-in fade-in-0 slide-in-from-bottom-3 zoom-in-[0.98] ease-power3-out relative flex h-full max-h-full flex-col overflow-hidden rounded-3xl bg-[#1c1c1c]/95 shadow-[0_24px_80px_rgba(0,0,0,0.6)] backdrop-blur-xl duration-200 md:h-auto md:max-h-[min(44rem,calc(100dvh-6rem))]"
      >
        {dragging && (
          <div
            aria-hidden
            className="bg-background/80 pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-3xl border-2 border-dashed border-white/20"
          >
            <span className="text-soft flex items-center gap-2 text-[14px]">
              <PaperclipIcon aria-hidden className="size-3.5" />
              Drop files to attach
            </span>
          </div>
        )}
        <header className={cn("flex h-11 shrink-0 items-center gap-1 pt-1 pr-2", where ? "pl-4" : "pl-5")}>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {where && <WorkspaceChip id={workspaceId || where} name={where} />}
            <span className="text-subtle min-w-0 truncate text-[13px]">{conversation?.title ?? "New chat"}</span>
          </span>
          {pendingBrief && (
            <Button variant="secondary" size="sm" className="mr-1 shrink-0 gap-1.5" disabled={busy} onClick={() => void showBrief(pendingBrief)}>
              <span aria-hidden className="bg-primary size-1.5 rounded-full" />
              Brief
            </Button>
          )}
          <Popover open={historyOpen} onOpenChange={(next) => void openHistory(next)}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Past chats" title="Past chats">
                <ClockIcon aria-hidden className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-1.5">
              {history === null ? (
                <p className="caption-style text-subtle px-2.5 py-3">Loading…</p>
              ) : history.length === 0 ? (
                <p className="caption-style text-subtle px-2.5 py-3">No chats</p>
              ) : (
                <ul className="flex max-h-80 flex-col overflow-y-auto">
                  {history.map((item) => (
                    <li key={item.id} className="group/item flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void load(item.id)}
                        className={cn(
                          "flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-white/5 focus-visible:bg-white/5",
                          item.id === conversation?.id && "bg-white/5",
                        )}
                      >
                        <span className="text-foreground w-full truncate text-[13.5px] leading-5">{item.title}</span>
                        <span className="caption-style text-subtle flex items-center gap-1.5">
                          {item.email && (
                            <span className={MARK_CLASS}>Email</span>
                          )}
                          {relativeWhen(item.updatedAt)}
                        </span>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${item.title}`}
                        className="opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100"
                        onClick={() => void remove(item.id)}
                      >
                        <TrashIcon aria-hidden className="size-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </PopoverContent>
          </Popover>
          <Button variant="ghost" size="icon-sm" aria-label="New chat" title="New chat" onClick={newChat}>
            <PlusIcon aria-hidden className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Minimise" title="Minimise (Esc)" onClick={() => setOpen(false)}>
            <ChevronDownIcon aria-hidden className="size-3" />
          </Button>
        </header>

        <div
          ref={scroller}
          onScroll={(event) => {
            const node = event.currentTarget;
            pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          }}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-contain px-5",
            messages.length > 0 || busy ? "pt-3 md:min-h-[12rem]" : "pt-3 md:flex-none",
          )}
        >
          <div aria-hidden className="pointer-events-none sticky top-0 z-10 -mx-5 -mt-3 -mb-1 h-4 bg-gradient-to-b from-[#1c1c1c] to-transparent" />
          {messages.length > 0 || busy ? (
            <div className="flex flex-col gap-5">
              {shownItems(
                messages.filter((message) => !message.waiting),
                busy,
              ).map((item) =>
                "message" in item ? (
                  <Message key={item.key} message={item.message} busy={busy} onDecide={decide} />
                ) : (
                  <ToolTrail key={item.key} tools={item.tools} />
                ),
              )}
              {busy && (live.length > 0 || !streamed) && <LiveSteps tools={live} thinking={live.every((tool) => tool.status === "done") && !streamed} />}
              {busy && streamed && (
                <div aria-busy="true">
                  <Markdown text={streamed} />
                </div>
              )}
              {messages
                .filter((message) => message.waiting)
                .map((message) => (
                  <div key={message.id} className="flex flex-col items-end gap-1">
                    <Message message={message} busy={busy} onDecide={decide} />
                    <p className="caption-style text-subtle">{!busy && cardsWaiting ? "Orbit reads this once you answer the changes above" : "Sent while Orbit was working"}</p>
                  </div>
                ))}
            </div>
          ) : (
            <div className="flex flex-col gap-3 pt-1 pb-2">
              <ul className="flex flex-wrap gap-1.5" aria-label="Suggestions">
                {(STARTERS.find((starter) => starter.match.test(pathname))?.prompts ?? []).map((prompt) => (
                  <li key={prompt}>
                    <button
                      type="button"
                      onClick={() => send(prompt)}
                      className="text-soft hover:text-foreground focus-visible:ring-ring/60 rounded-full bg-white/[0.05] px-3 py-1.5 text-left text-[13px] leading-5 outline-none transition-colors duration-150 hover:bg-white/[0.09] focus-visible:ring-2"
                    >
                      {prompt}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error && (
            <p role="alert" className="caption-style text-danger pt-3">
              {error}
            </p>
          )}
          {working && !busy && !error ? (
            <p role="status" className="caption-style text-soft pt-3">
              {workingText(working)}
            </p>
          ) : (
            notice &&
            !error && (
              <p role="status" className="caption-style text-soft pt-3">
                {notice}
              </p>
            )
          )}
          <div aria-hidden className="pointer-events-none sticky bottom-0 z-10 -mx-5 h-5 shrink-0 bg-gradient-to-t from-[#1c1c1c] to-transparent" />
        </div>

        <form onSubmit={submit} className="shrink-0 px-5 pt-1 pb-3">
          <div className="flex flex-col gap-2">
            <AttachmentList items={files.items} onRemove={files.remove} />
            <label htmlFor="assistant-input" className="sr-only">
              Message Orbit
            </label>
            <MentionInput
              id="assistant-input"
              inputRef={input}
              value={draft}
              mentions={mentions}
              onChange={(next, nextMentions) => {
                setDraft(next);
                setMentions(nextMentions);
              }}
              onSubmit={() => send(draft)}
              placeholder="Ask Orbit… @ to tag"
            />
            <div className="flex items-center gap-1.5">
              <Select
                value={active.model}
                onValueChange={(next) => {
                  modelChosen.current = true;
                  setModel(next);
                  setReasoning(settingsFor(next, reasoning).reasoning);
                }}
              >
                <SelectTrigger aria-label="Model" className="-ml-2.5 h-7 w-auto min-w-0 gap-1.5 rounded-full border-transparent bg-transparent px-2.5 text-[12.5px] whitespace-nowrap hover:bg-white/5">
                  <SelectValue className="min-w-0 truncate">
                    {chosen.label}
                    {chosen.source !== "orbit" && <span className="text-subtle"> · {chosen.source === "claude" ? "Claude" : "ChatGPT"}</span>}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent side="top" align="start">
                  {groups.length === 1
                    ? groups[0].models.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                          <span className="text-subtle"> · {option.maker}</span>
                        </SelectItem>
                      ))
                    : groups.map((group) => (
                        <SelectGroup key={group.id}>
                          <SelectLabel>{group.label}</SelectLabel>
                          {group.models.map((option) => (
                            <SelectItem key={option.id} value={option.id}>
                              {option.label}
                              {group.id === "orbit" && <span className="text-subtle"> · {option.maker}</span>}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                </SelectContent>
              </Select>
              <Select
                value={active.reasoning}
                onValueChange={(next) => {
                  modelChosen.current = true;
                  setReasoning(next as ReasoningLevel);
                }}
              >
                <SelectTrigger aria-label="Reasoning" className="h-7 w-auto min-w-0 gap-1.5 rounded-full border-transparent bg-transparent px-2.5 text-[12.5px] whitespace-nowrap hover:bg-white/5">
                  <SelectValue className="min-w-0 truncate">{REASONING_LABELS[active.reasoning]}</SelectValue>
                </SelectTrigger>
                <SelectContent side="top" align="start">
                  {chosen.reasoning.map((level) => (
                    <SelectItem key={level} value={level}>
                      {REASONING_LABELS[level]} reasoning
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                type="button"
                aria-pressed={webSearch}
                onClick={() => setWebSearch((current) => !current)}
                title={webSearch ? "Web search on" : "Web search off"}
                className={cn(
                  "focus-visible:ring-ring/60 ease-power3-out flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[12.5px] transition-colors duration-150 outline-none focus-visible:ring-2",
                  webSearch ? "bg-white/[0.08] text-foreground" : "text-subtle hover:text-foreground hover:bg-white/5",
                )}
              >
                <GlobeIcon aria-hidden className="size-3.5" />
                <span className="max-sm:sr-only">Web</span>
              </button>
              <AttachButton compact id="assistant-files" onFiles={(picked) => void files.add(picked)} />
              <span className="flex-1" />
              {busy && (
                <Button variant="secondary" size="icon" type="button" aria-label="Stop" className="shrink-0" onClick={stopTurn}>
                  <StopIcon aria-hidden className="size-3.5" />
                </Button>
              )}
              <Button
                variant="primary"
                size="icon"
                type="submit"
                aria-label="Send"
                className="shrink-0"
                title={files.uploading ? "Wait for the files to upload" : busy || working ? "Send now. Orbit takes it into account as it works" : `Send (Enter). New line: ${mac ? "⇧" : "Shift"}+Enter`}
                disabled={!canSend || ((busy || Boolean(working)) && !conversation)}
              >
                <ArrowUpIcon aria-hidden className="size-3.5" />
              </Button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
