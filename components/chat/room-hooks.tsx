"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
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

const FIELD = "border-line-strong bg-surface-field text-soft flex min-w-0 flex-1 items-center rounded-lg border px-2.5 font-mono text-[12px]";

export type HookSecrets = { secrets: Record<string, string>; set: (roomId: string, hookId: string, secret: string | null) => void };

function useOrigin() {
  return useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => "",
  );
}

function useRefreshTick(open: boolean) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const refresh = () => {
      if (document.visibilityState === "visible") setTick((value) => value + 1);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [open]);
  return tick;
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
            <code className={cn(FIELD, "h-8 truncate max-md:h-11")} title={url}>
              {url}
            </code>
            <CopyButton text={url} label="Copy URL" className="max-md:h-11" />
          </div>
          {secret && (
            <div className="flex flex-col gap-2 rounded-xl border border-(--tag-amber-border) bg-(--tag-amber-bg) p-3">
              <span className="ui-style font-medium text-(--tag-amber-text)">Secret</span>
              <div className="flex items-center gap-2">
                <code className={cn(FIELD, "min-h-8 bg-black/25 py-1.5 leading-[18px] break-all")}>{secret}</code>
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
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRotating(true)} aria-label={`Rotate secret for ${hook.name}`} className="max-md:h-11">
              Rotate secret
            </Button>
            <HoldButton onConfirm={onDelete} disabled={busy} className="ml-auto max-md:h-11">
              Hold to delete<span className="sr-only"> {hook.name}</span>
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

export default function RoomHooks({ open, roomId, roomName, secrets }: { open: boolean; roomId: string; roomName: string; secrets: HookSecrets }) {
  const ids = { heading: useId(), name: useId() };
  const [hooks, setHooks] = useState<ChatHook[] | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setErrorState] = useState<{ load: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const mutations = useRef(0);
  const currentRoom = useRef(roomId);
  useEffect(() => {
    currentRoom.current = roomId;
  }, [roomId]);
  const setError = (text: string | null) => setErrorState(text ? { load: false, text } : null);
  const tick = useRefreshTick(open);
  const [seen, setSeen] = useState({ open, roomId });
  if (seen.open !== open || seen.roomId !== roomId) {
    setSeen({ open, roomId });
    setAdding(false);
    setName("");
    setExpanded({});
    setError(null);
    if (seen.roomId !== roomId) setHooks(null);
  }

  useEffect(() => {
    if (!open) return;
    let live = true;
    const started = mutations.current;
    void listHooksAction(roomId)
      .then((result) => {
        if (!live || started !== mutations.current) return;
        if ("hooks" in result) {
          setHooks(result.hooks);
          setLoaded(roomId);
          setErrorState((current) => (current?.load ? null : current));
        } else setErrorState({ load: true, text: result.error });
      })
      .catch(() => {
        if (live && started === mutations.current) setErrorState({ load: true, text: "Couldn't load webhooks. Try again." });
      });
    return () => {
      live = false;
    };
  }, [open, roomId, tick, reload]);

  function replace(hook: ChatHook) {
    setHooks((current) => (current ?? []).map((item) => (item.id === hook.id ? hook : item)));
  }

  async function run<T>(work: () => Promise<T>, fallback: string, done: (result: T) => void) {
    const room = roomId;
    mutations.current += 1;
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (currentRoom.current === room) done(result);
    } catch {
      if (currentRoom.current === room) setError(fallback);
    } finally {
      mutations.current += 1;
      setBusy(false);
      setReload((value) => value + 1);
    }
  }

  function add() {
    if (!name.trim() || busy) return;
    void run(
      () => createHookAction(roomId, name),
      "Couldn't add the webhook. Try again.",
      (result) => {
        if (!("hook" in result)) return setError(result.error);
        secrets.set(roomId, result.hook.id, result.secret);
        setHooks((current) => [...(current ?? []).filter((item) => item.id !== result.hook.id), result.hook]);
        setLoaded(roomId);
        setExpanded((current) => ({ ...current, [result.hook.id]: true }));
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
        secrets.set(roomId, result.hook.id, result.secret);
        replace(result.hook);
        setExpanded((current) => ({ ...current, [result.hook.id]: true }));
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
        secrets.set(roomId, hook.id, null);
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
          {error.text}
        </p>
      )}
      {list && list.length > 0 && (
        <ul className="flex flex-col gap-2">
          {list.map((hook) => (
            <HookRow
              key={hook.id}
              hook={hook}
              roomName={roomName}
              expanded={expanded[hook.id] ?? Boolean(secrets.secrets[hook.id])}
              secret={secrets.secrets[hook.id] ?? null}
              busy={busy}
              onToggle={() => setExpanded((current) => ({ ...current, [hook.id]: !(current[hook.id] ?? Boolean(secrets.secrets[hook.id])) }))}
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
