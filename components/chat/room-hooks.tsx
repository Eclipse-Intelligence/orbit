"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import Button from "@/components/_ui/button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import CopyButton from "@/components/_ui/copy-button";
import HoldButton from "@/components/_ui/hold-button";
import { Input } from "@/components/_ui/input";
import Tag from "@/components/_ui/tag";
import { createHookAction, deleteHookAction, listHooksAction, rotateHookSecretAction, setHookPausedAction } from "@/app/(crm)/chat/actions";
import { useChat } from "@/components/chat/chat-context";
import { HookAvatar } from "@/components/chat/hook-message";
import { clockTime, dayLabel } from "@/lib/chat/format";
import { CHAT_HOOK_NAME_MAX, type ChatHook } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import ChevronIcon from "@/public/assets/images/_common/chevron-right.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

const FIELD = "border-line-strong bg-surface-field text-soft flex h-8 min-w-0 flex-1 items-center truncate rounded-lg border px-2.5 font-mono text-[12px] max-md:h-11";

function useOrigin() {
  return useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => "",
  );
}

function lastPost(iso: string | null, now: number) {
  if (!iso) return "No posts yet";
  const day = dayLabel(iso, now);
  const when = day === "Today" || day === "Yesterday" ? day.toLowerCase() : day;
  return `Last post ${when} ${clockTime(iso)}`;
}

function HookRow({
  hook,
  roomName,
  expanded,
  secret,
  busy,
  onToggle,
  onPause,
  onRotate,
  onDelete,
}: {
  hook: ChatHook;
  roomName: string;
  expanded: boolean;
  secret: string | null;
  busy: boolean;
  onToggle: () => void;
  onPause: () => void;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const { now } = useChat();
  const origin = useOrigin();
  const url = `${origin}/api/chat/hooks/${hook.id}`;
  const panel = useId();
  const [rotating, setRotating] = useState(false);
  const paused = Boolean(hook.pausedAt);
  return (
    <li className="border-line-strong flex flex-col rounded-xl border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panel}
        className="hover:bg-surface-hover flex min-h-14 items-center gap-2.5 rounded-xl px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <HookAvatar size="md" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="ui-style truncate">{hook.name}</span>
          <span className="caption-style text-subtle truncate">{lastPost(hook.lastUsedAt, now)}</span>
        </span>
        <Tag size="sm" tone={paused ? "neutral" : "green"} className="h-[18px] text-[11px]">
          {paused ? "Paused" : "Active"}
        </Tag>
        <ChevronIcon aria-hidden className={cn("text-subtle size-3 shrink-0 transition-transform duration-150 ease-power3-out", expanded && "rotate-90")} />
      </button>
      {expanded && (
        <div id={panel} className="flex flex-col gap-2 px-3.5 pb-3.5">
          <div className="flex items-center gap-2">
            <code className={FIELD} title={url}>
              {url}
            </code>
            <CopyButton text={url} label="Copy URL" className="max-md:h-11" />
          </div>
          {secret && (
            <div className="flex flex-col gap-2 rounded-xl border border-(--tag-amber-border) bg-(--tag-amber-bg) p-3">
              <span className="ui-style font-medium text-(--tag-amber-text)">Secret</span>
              <div className="flex items-center gap-2">
                <code className={cn(FIELD, "bg-black/25")}>{secret}</code>
                <CopyButton text={secret} label="Copy secret" className="max-md:h-11" />
              </div>
              <span className="caption-style text-soft">
                Copy it now. It won&apos;t be shown again. Senders use <code className="font-mono">Authorization: Bearer</code> with this secret.
              </span>
            </div>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <Button variant="ghost" size="sm" disabled={busy} onClick={onPause} aria-label={`${paused ? "Resume" : "Pause"} ${hook.name}`} className="max-md:h-11">
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRotating(true)} className="max-md:h-11">
              Rotate secret
            </Button>
            <HoldButton onConfirm={onDelete} disabled={busy} className="ml-auto max-md:h-11">
              Hold to delete
            </HoldButton>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={rotating}
        onOpenChange={setRotating}
        title={`Rotate the secret for ${hook.name}?`}
        description={`The current secret stops working at once. Posts to #${roomName} fail until the sender uses the new one.`}
        confirmLabel="Rotate secret"
        onConfirm={onRotate}
      />
    </li>
  );
}

export default function RoomHooks({ open, roomId, roomName }: { open: boolean; roomId: string; roomName: string }) {
  const ids = { heading: useId(), name: useId() };
  const [hooks, setHooks] = useState<ChatHook[] | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ hookId: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState({ open, roomId });
  if (seen.open !== open || seen.roomId !== roomId) {
    setSeen({ open, roomId });
    setAdding(false);
    setName("");
    setExpanded(null);
    setSecret(null);
    setError(null);
    if (seen.roomId !== roomId) setHooks(null);
  }

  useEffect(() => {
    if (!open) return;
    let live = true;
    void listHooksAction(roomId)
      .then((result) => {
        if (!live) return;
        if ("hooks" in result) {
          setHooks(result.hooks);
          setLoaded(roomId);
        } else setError(result.error);
      })
      .catch(() => {
        if (live) setError("Couldn't load webhooks. Try again.");
      });
    return () => {
      live = false;
    };
  }, [open, roomId]);

  function replace(hook: ChatHook) {
    setHooks((current) => (current ?? []).map((item) => (item.id === hook.id ? hook : item)));
  }

  async function run<T>(work: () => Promise<T>, fallback: string, done: (result: T) => void) {
    setBusy(true);
    setError(null);
    try {
      done(await work());
    } catch {
      setError(fallback);
    } finally {
      setBusy(false);
    }
  }

  function add() {
    if (!name.trim() || busy) return;
    void run(
      () => createHookAction(roomId, name),
      "Couldn't add the webhook. Try again.",
      (result) => {
        if (!("hook" in result)) return setError(result.error);
        setHooks((current) => [...(current ?? []), result.hook]);
        setSecret({ hookId: result.hook.id, value: result.secret });
        setExpanded(result.hook.id);
        setAdding(false);
        setName("");
      },
    );
  }

  function pause(hook: ChatHook) {
    const paused = !hook.pausedAt;
    const fallback = paused ? "Couldn't pause the webhook. Try again." : "Couldn't resume the webhook. Try again.";
    void run(
      () => setHookPausedAction(hook.id, paused),
      fallback,
      (result) => ("hook" in result ? replace(result.hook) : setError(result.error)),
    );
  }

  function rotate(hook: ChatHook) {
    void run(
      () => rotateHookSecretAction(hook.id),
      "Couldn't rotate the secret. Try again.",
      (result) => {
        if (!("hook" in result)) return setError(result.error);
        replace(result.hook);
        setSecret({ hookId: result.hook.id, value: result.secret });
      },
    );
  }

  function remove(hook: ChatHook) {
    void run(
      () => deleteHookAction(hook.id),
      "Couldn't delete the webhook. Try again.",
      (result) => {
        if (!("deleted" in result)) return setError(result.error);
        setHooks((current) => (current ?? []).filter((item) => item.id !== hook.id));
        if (secret?.hookId === hook.id) setSecret(null);
      },
    );
  }

  const list = loaded === roomId ? hooks : null;

  return (
    <section aria-labelledby={ids.heading} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 id={ids.heading} className="flex-1">
          Incoming webhooks
        </h3>
        <Button variant="secondary" size="sm" onClick={() => setAdding((value) => !value)} aria-expanded={adding} className="max-md:h-11">
          <PlusIcon aria-hidden className="size-3" />
          Add incoming webhook
        </Button>
      </div>
      {adding && (
        <div className="flex flex-col gap-2">
          <label htmlFor={ids.name} className="lead-style font-medium">
            Webhook name
          </label>
          <Input
            id={ids.name}
            value={name}
            maxLength={CHAT_HOOK_NAME_MAX}
            placeholder="Google Analytics"
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
            className="max-md:h-11"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)} className="max-md:h-11">
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={!name.trim() || busy} onClick={add} className="max-md:h-11">
              Add
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      {list && list.length > 0 && (
        <ul className="flex flex-col gap-2">
          {list.map((hook) => (
            <HookRow
              key={hook.id}
              hook={hook}
              roomName={roomName}
              expanded={expanded === hook.id}
              secret={secret?.hookId === hook.id ? secret.value : null}
              busy={busy}
              onToggle={() => setExpanded((current) => (current === hook.id ? null : hook.id))}
              onPause={() => pause(hook)}
              onRotate={() => rotate(hook)}
              onDelete={() => remove(hook)}
            />
          ))}
        </ul>
      )}
      <p className="caption-style text-subtle">
        POST JSON <code className="font-mono">{`{"text", "title", "url"}`}</code> with <code className="font-mono">Authorization: Bearer</code> and the secret. Other JSON shows as a formatted
        block. Hook messages never tag anyone.
      </p>
    </section>
  );
}
