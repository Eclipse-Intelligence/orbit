"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import { Input } from "@/components/_ui/input";
import { Textarea } from "@/components/_ui/textarea";
import type { CommentThread, PublicComment } from "@/lib/docs/comment-client";
import { cn } from "@/lib/utils";

export const COMMENT_BODY_LIMIT = 2000;
export const COMMENT_NAME_LIMIT = 60;

export type CommentActions = {
  name: string;
  reply: (parentId: string, name: string, body: string) => Promise<string | null>;
  edit: (id: string, body: string) => Promise<string | null>;
  remove: (id: string) => Promise<string | null>;
};

const AVATARS = ["bg-[#b1ebc5]", "bg-[#bfdbfe]", "bg-[#fde68a]", "bg-[#fbcfe8]", "bg-[#ddd6fe]", "bg-[#fed7aa]"];

function avatarOf(name: string) {
  let sum = 0;
  for (const char of name) sum = (sum + char.charCodeAt(0)) % AVATARS.length;
  return AVATARS[sum];
}

function initialsOf(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => Array.from(part)[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

export function agoLabel(iso: string, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" }).format(new Date(iso));
}

export function Avatar({ name }: { name: string }) {
  return (
    <span aria-hidden className={cn("flex size-[22px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-[#101010]", avatarOf(name))}>
      {initialsOf(name)}
    </span>
  );
}

export function Composer({
  label,
  placeholder,
  submitLabel,
  name,
  initial = "",
  autoFocus = false,
  onSubmit,
  onCancel,
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  name: string;
  initial?: string;
  autoFocus?: boolean;
  onSubmit: (name: string, body: string) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [who, setWho] = useState(name);
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const askName = !name && !initial;
  const ready = text.trim().length > 0 && (!askName || who.trim().length > 0);

  async function submit() {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    let problem: string | null;
    try {
      problem = await onSubmit((askName ? who : name).trim(), text.trim());
    } catch {
      problem = `Couldn't ${submitLabel.toLowerCase()}. Try again.`;
    } finally {
      setSaving(false);
    }
    if (problem) setError(problem);
    else setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" && onCancel) {
      event.stopPropagation();
      onCancel();
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {askName && <Input aria-label="Your name" placeholder="Your name" maxLength={COMMENT_NAME_LIMIT} autoComplete="name" value={who} onChange={(event) => setWho(event.target.value)} />}
      <Textarea
        aria-label={label}
        placeholder={placeholder}
        maxLength={COMMENT_BODY_LIMIT}
        autoFocus={autoFocus}
        rows={2}
        value={text}
        disabled={saving}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="min-h-16 resize-none text-[13px]"
      />
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5">
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} className="hit">
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" size="sm" disabled={!ready || saving} className="hit">
          {saving ? "Saving" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function OneComment({ comment, actions }: { comment: PublicComment; actions: CommentActions }) {
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Avatar name={comment.authorName} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{comment.authorName}</span>
        <span className="text-subtle shrink-0 text-[11px]">
          {agoLabel(comment.createdAt)}
          {comment.editedAt ? " (edited)" : ""}
        </span>
      </div>
      {editing ? (
        <Composer
          label="Edit comment"
          placeholder="Comment"
          submitLabel="Save"
          name={comment.authorName}
          initial={comment.body}
          autoFocus
          onCancel={() => setEditing(false)}
          onSubmit={async (_name, body) => {
            const result = await actions.edit(comment.id, body);
            if (!result) setEditing(false);
            return result;
          }}
        />
      ) : (
        <p className="text-foreground/90 text-[13px] leading-[1.5] break-words whitespace-pre-wrap">{comment.body}</p>
      )}
      {comment.mine && !editing && (
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)} className="hit px-2 py-1.5">
            Edit
          </Button>
          <HoldButton
            size="sm"
            onConfirm={async () => setProblem(await actions.remove(comment.id))}
            holding="Keep holding"
            className="px-2 py-1.5"
          >
            Hold to delete
          </HoldButton>
        </div>
      )}
      {problem && (
        <p role="alert" className="caption-style text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}

export function ThreadCard({
  thread,
  active,
  orphaned,
  quiet,
  actions,
  onActivate,
  children,
}: {
  thread: CommentThread;
  active: boolean;
  orphaned: boolean;
  quiet: boolean;
  actions: CommentActions;
  onActivate: () => void;
  children?: ReactNode;
}) {
  const quote = thread.root.anchor?.quote ?? "";
  const replies = thread.replies.length;
  return (
    <div
      data-thread={thread.root.id}
      onClick={onActivate}
      className={cn(
        "flex flex-col gap-2 rounded-xl p-3 ring-1 transition-shadow duration-150 ease-power3-out",
        quiet ? "bg-white/3 ring-transparent" : "bg-popover ring-white/6",
        active && "shadow-overlay",
      )}
    >
      {quote && (
        <p className={cn("text-soft line-clamp-3 border-l-2 pl-2 text-[12px] leading-[1.45]", orphaned || quiet ? "border-faint decoration-white/25" : "border-yellow-400/55", orphaned && "line-through")}>{quote}</p>
      )}
      <OneComment comment={thread.root} actions={actions} />
      {active && replies > 0 && (
        <div className="flex flex-col gap-3">
          {thread.replies.map((reply) => (
            <div key={reply.id} className="border-border flex flex-col gap-1.5 border-t pt-2">
              <OneComment comment={reply} actions={actions} />
            </div>
          ))}
        </div>
      )}
      {!active && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onActivate();
          }}
          className="hit -mx-1 self-start px-1 py-1 text-[12px]"
        >
          {replies > 0 ? `${replies} ${replies === 1 ? "reply" : "replies"}` : "Reply"}
        </Button>
      )}
      {active && !quiet && (
        <div className="border-border border-t pt-2">
          <Composer
            label={`Reply as ${actions.name || "you"}`}
            placeholder={actions.name ? `Reply as ${actions.name}` : "Reply"}
            submitLabel="Reply"
            name={actions.name}
            onSubmit={(name, body) => actions.reply(thread.root.id, name, body)}
          />
        </div>
      )}
      {children}
    </div>
  );
}
