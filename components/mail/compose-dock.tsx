"use client";

import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Button from "@/components/_ui/button";
import type { LaterRequest } from "@/components/mail/later-picker";
import type { ComposerDraft, ComposerStart, SendPayload, SendTracker } from "@/components/mail/mail-composer";
import { ComposerLoading } from "@/components/mail/composer-loading";
import { handOverPayload } from "@/components/mail/hand-over";
import { heldDrafts } from "@/components/mail/held-drafts";
import { flagReconnect, hasReconnectHost, reconnectOf } from "@/components/mail/reconnect-store";
import { MODE_LABEL } from "@/lib/mail/format";
import { emailRecipientAction } from "@/app/(crm)/quick-add";
import type { MailAddress } from "@/lib/mail/types";
import type { ComposeAccount, MailDraft } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import XIcon from "@/public/assets/images/companies/detail/x.svg";
import CloseIcon from "@/public/assets/images/mail/close.svg";
import MinimiseIcon from "@/public/assets/images/mail/minimise.svg";

const MAX_CARDS = 6;
const CARD_WIDTH = 544;
const GAP = 12;
const EDGE = 16;
const UNDO_MS = 10_000;
const TOAST_MS = 5_000;

type Toast = {
  message: string;
  tone?: "status" | "alert";
  action?: { label: string; run: () => void };
  extra?: { label: string; short?: string; run: () => void };
  duration?: number;
};

type ShownToast = Toast & { id: number };

type SendMeta = { onDelivered?: () => void; onUndone?: () => void; onReopen?: (draft: ComposerDraft) => boolean; track?: SendTracker };

type Outgoing = SendMeta & { payload: Promise<SendPayload>; timer: number };

type SendFailure = Error & { status?: number; detail?: { draftId?: string; maybeSent?: boolean; stillSaving?: boolean } };

type Card = {
  key: number;
  start: ComposerStart;
  title: string;
  minimised: boolean;
  position: { x: number; y: number } | null;
  layer: number;
  onSent?: () => void;
  track?: SendTracker;
};

type OpenOptions = { to?: MailAddress[]; contactId?: string | null; draft?: ComposerDraft; subject?: string; body?: string; onSent?: () => void; heldKey?: string; fromEmail?: string | null; track?: SendTracker };

type ComposerContextValue = {
  openComposer: (options?: OpenOptions) => void;
  sent: number;
  queueSend: (payload: Promise<SendPayload>, meta?: SendMeta) => void;
  scheduleSend: (payload: Promise<SendPayload>, sendAt: string, detail: string) => void;
  pickLater: (request: LaterRequest) => void;
  showToast: (toast: Toast) => number;
  dismissToast: (id: number) => void;
  undoLatest: () => boolean;
};

async function postJson<T>(url: string, body: unknown, keepalive = false): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive });
  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw Object.assign(new Error(json.error ?? "Couldn't send. Try again."), { status: response.status, detail: json, reconnect: (json as { reconnect?: unknown }).reconnect ?? null });
  }
  return json;
}

function payloadDraft(payload: SendPayload, failure?: SendFailure): ComposerDraft {
  return {
    id: failure?.detail?.draftId ?? payload.id ?? "",
    sendKey: payload.sendKey ?? null,
    sendProblem: failure?.detail?.maybeSent ? failure.message : null,
    sourceId: payload.sourceId,
    replaces: payload.replaces ?? null,
    unsaved: Boolean(failure?.detail?.draftId || failure?.detail?.stillSaving),
    mode: payload.mode,
    messageId: payload.messageId,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    subject: payload.subject,
    body: payload.body,
    savedAt: "",
    sendAt: null,
    sendError: null,
    identityId: payload.identityId ?? null,
    attachments: payload.files,
    remindHours: payload.remindHours,
    followUpDays: payload.followUpDays,
    followUpBody: payload.followUpBody,
    shareId: payload.shareId ?? null,
  };
}

const ComposerContext = createContext<ComposerContextValue | null>(null);

const loadComposer = () => import("@/components/mail/mail-composer");
const MailComposer = dynamic(loadComposer, { ssr: false, loading: () => <ComposerLoading fill /> });
const LaterPicker = dynamic(() => import("@/components/mail/later-picker"), { ssr: false });

const NO_ACCOUNTS: ComposeAccount[] = [];

const SHEET_QUERY = "(max-width: 639px)";

function watchSheet(notify: () => void) {
  const query = window.matchMedia(SHEET_QUERY);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

function useSheet() {
  return useSyncExternalStore(
    watchSheet,
    () => window.matchMedia(SHEET_QUERY).matches,
    () => false,
  );
}

export function useComposer() {
  const value = useContext(ComposerContext);
  if (!value) throw new Error("useComposer needs a ComposerProvider");
  return value;
}

async function loadAccounts(): Promise<ComposeAccount[]> {
  const response = await fetch("/api/mail/accounts", { cache: "no-store" });
  if (!response.ok) throw new Error("Mail accounts didn't load.");
  const body = (await response.json()) as { accounts: ComposeAccount[] };
  return body.accounts;
}

const ComposeCard = memo(function ComposeCard({
  card,
  index,
  perRow,
  desktop,
  sheet,
  stack,
  accounts,
  onChange,
  onRemove,
  onFront,
}: {
  card: Card;
  index: number;
  perRow: number;
  desktop: boolean;
  sheet: boolean;
  stack: number;
  accounts: ComposeAccount[];
  onChange: (key: number, change: Partial<Card>) => void;
  onRemove: (key: number) => void;
  onFront: (key: number) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; dx: number; dy: number } | null>(null);
  const setTitle = useCallback((subject: string) => onChange(card.key, { title: subject.trim() }), [onChange, card.key]);
  const remove = useCallback(() => onRemove(card.key), [onRemove, card.key]);
  const front = useCallback(() => onFront(card.key), [onFront, card.key]);
  const [held, setHeld] = useState(false);
  const draggable = desktop && !sheet;
  const fitsKeyboard = sheet && !card.minimised;

  useEffect(() => {
    const viewport = window.visualViewport;
    const node = element.current;
    if (!fitsKeyboard || !viewport || !node) return;
    const fit = () => {
      node.style.height = `${viewport.height}px`;
      node.style.top = `${viewport.offsetTop}px`;
      if (window.innerHeight - viewport.height > 80) node.dataset.keyboard = "";
      else delete node.dataset.keyboard;
    };
    fit();
    viewport.addEventListener("resize", fit);
    viewport.addEventListener("scroll", fit);
    return () => {
      viewport.removeEventListener("resize", fit);
      viewport.removeEventListener("scroll", fit);
      node.style.height = "";
      node.style.top = "";
      delete node.dataset.keyboard;
    };
  }, [fitsKeyboard]);

  function down(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button") || !draggable) return;
    const rect = element.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = { pointer: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    front();
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    const rect = element.current?.getBoundingClientRect();
    if (!state || state.pointer !== event.pointerId || !rect) return;
    const x = Math.min(Math.max(EDGE / 2, event.clientX - state.dx), window.innerWidth - rect.width - EDGE / 2);
    const y = Math.min(Math.max(EDGE / 2, event.clientY - state.dy), window.innerHeight - 56);
    onChange(card.key, { position: { x, y } });
  }

  function up(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointer === event.pointerId) drag.current = null;
  }

  const title = card.title || MODE_LABEL[card.start.mode];
  const column = index % perRow;
  const row = Math.floor(index / perRow);
  const placed = !draggable
    ? {}
    : card.position
      ? { left: card.position.x, top: card.position.y }
      : { right: EDGE + column * (CARD_WIDTH + GAP) + row * 28, bottom: EDGE + row * 28 };

  return (
    <div
      ref={element}
      role="dialog"
      aria-label={title}
      onPointerDownCapture={front}
      className={cn(
        "bg-popover pointer-events-auto fixed flex flex-col overflow-hidden",
        sheet
          ? "animate-in fade-in slide-in-from-bottom-6 ease-power3-out inset-x-0 top-0 h-dvh pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] duration-200 data-[keyboard]:pb-0 motion-reduce:animate-none"
          : "border-line-strong shadow-overlay animate-rise-in inset-x-2 bottom-2 h-[85dvh] rounded-2xl border md:inset-x-auto md:bottom-auto md:h-[min(34rem,calc(100dvh-2rem))] md:w-[34rem]",
        card.minimised && "hidden",
      )}
      style={{ ...placed, zIndex: `calc(var(--z-compose) + ${Math.min(stack, 8)})` }}
    >
      <div
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className={cn("flex shrink-0 cursor-default items-center gap-2 py-2 pr-2 pl-4 select-none", draggable && "cursor-grab active:cursor-grabbing")}
      >
        <span className="text-foreground min-w-0 flex-1 truncate text-[13px] font-medium">{title}</span>
        <Button variant="ghost" size="icon-sm" aria-label={`Minimise ${title}`} title="Minimise" onClick={() => onChange(card.key, { minimised: true })} className="pointer-coarse:size-11">
          <MinimiseIcon aria-hidden className="size-2.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={held ? `Close ${title}. It isn't saved yet` : `Close ${title}, keeping the draft`}
          title={held ? "Close (not saved yet, kept in this tab)" : "Close (draft kept)"}
          onClick={remove}
          className="pointer-coarse:size-11"
        >
          <CloseIcon aria-hidden className="size-2.5" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {accounts.length === 0 ? (
          <p className="caption-style text-subtle px-4 pb-4">Connect a mailbox in Settings › Email.</p>
        ) : (
          <MailComposer
            start={card.start}
            accounts={accounts}
            variant="card"
            onSubject={setTitle}
            onClose={remove}
            onSent={remove}
            onDelivered={card.onSent}
            onScheduled={card.onSent}
            track={card.track}
            onHeld={setHeld}
          />
        )}
      </div>
    </div>
  );
});

export function ComposerProvider({ children }: { children: ReactNode }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [accounts, setAccounts] = useState<ComposeAccount[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const [toasts, setToasts] = useState<ShownToast[]>([]);
  const [later, setLater] = useState<LaterRequest | null>(null);
  const sheet = useSheet();
  const toastCounter = useRef(0);
  const shownMessages = useRef(new Map<string, number>());
  const toastTimers = useRef(new Map<number, number>());
  const outgoing = useRef(new Map<number, Outgoing>());
  const [viewport, setViewport] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  const cardsRef = useRef<Card[]>([]);
  const counter = useRef(0);
  const layers = useRef(0);
  const accountsCache = useRef<ComposeAccount[] | null>(null);
  const accountsRequest = useRef<Promise<ComposeAccount[] | null> | null>(null);

  useEffect(() => {
    cardsRef.current = cards;
  });

  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1500));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const handle = idle(() => void loadComposer().catch(() => null));
    return () => cancel(handle);
  }, []);

  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const openComposer = useCallback((options: OpenOptions = {}) => {
    const cached = accountsCache.current;
    const fresh = loadAccounts().catch(() => null);
    accountsRequest.current = fresh;
    void fresh.then((list) => {
      if (!list || accountsRequest.current !== fresh) return;
      accountsCache.current = list;
      setAccounts(list);
    });
    void (async () => {
      const [list, contact] = await Promise.all([
        cached ? Promise.resolve(cached) : fresh.then((loaded) => loaded ?? []),
        options.contactId ? emailRecipientAction(options.contactId).catch(() => null) : Promise.resolve(null),
      ]);
      const earlier = cached ?? [];
      setAccounts(accountsCache.current ?? list);
      const to = options.to ?? (contact?.email ? [{ address: contact.email.toLowerCase(), name: contact.name }] : []);
      const preferred = list.find((item) => item.default) ?? list[0];
      const sourceId = options.draft?.sourceId ?? preferred?.sourceId ?? preferred?.id ?? "";
      const prefilled: MailDraft | null =
        !options.draft && options.body
          ? { id: "", sourceId, mode: "new", messageId: null, to, cc: [], bcc: [], subject: options.subject ?? "", body: options.body, savedAt: "", sendAt: null, sendError: null }
          : null;
      const start: ComposerStart = {
        mode: options.draft?.mode ?? "new",
        messageId: options.draft?.messageId ?? null,
        sourceId,
        to,
        cc: [],
        subject: options.subject ?? "",
        draft: options.draft ?? prefilled,
        fromId: options.draft ? null : (preferred?.id ?? null),
        fromEmail:
          options.fromEmail ??
          (options.draft
            ? (earlier.find((item) => item.id === (options.draft!.identityId ? `smtp:${options.draft!.identityId}` : options.draft!.sourceId))?.email ?? null)
            : null),
        heldKey: options.heldKey,
        replaces: options.draft?.replaces ?? null,
      };
      const existing = options.draft?.id ? cardsRef.current.find((card) => card.start.draft?.id === options.draft!.id) : null;
      if (existing) {
        const layer = ++layers.current;
        setCards((current) => current.map((card) => (card.key === existing.key ? { ...card, minimised: false, layer } : card)));
        return;
      }
      if (cardsRef.current.length >= MAX_CARDS) {
        setNotice(`${MAX_CARDS} emails are open. Close one first.`);
        return;
      }
      counter.current += 1;
      const card: Card = {
        key: counter.current,
        start,
        title: options.draft?.subject ?? options.subject ?? "",
        minimised: false,
        position: null,
        layer: ++layers.current,
        onSent: options.onSent,
        track: options.track,
      };
      cardsRef.current = [...cardsRef.current, card];
      setCards((current) => [...current, card]);
    })();
  }, []);

  useEffect(() => {
    for (const held of heldDrafts().slice(0, MAX_CARDS)) openComposer({ draft: held.draft, heldKey: held.key, fromEmail: held.fromEmail });
  }, [openComposer]);

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(toastTimers.current.get(id));
    toastTimers.current.delete(id);
    for (const [message, shownId] of shownMessages.current) if (shownId === id) shownMessages.current.delete(message);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    (toast: Toast) => {
      const repeat = toast.action ? undefined : shownMessages.current.get(toast.message);
      if (repeat !== undefined) return repeat;
      const id = ++toastCounter.current;
      if (!toast.action) shownMessages.current.set(toast.message, id);
      setToasts((current) => [...current.slice(-2), { ...toast, id }]);
      toastTimers.current.set(
        id,
        window.setTimeout(() => dismiss(id), toast.duration ?? (toast.action ? TOAST_MS + 2_000 : TOAST_MS)),
      );
      return id;
    },
    [dismiss],
  );

  const handedBack = useCallback(
    (problem: unknown, track?: SendTracker) => {
      const value = handOverPayload(problem);
      const message = problem instanceof Error ? problem.message : "Couldn't send. Try again.";
      if (value) openComposer({ draft: payloadDraft(value), track });
      showToast({ message: `“${value?.subject || "Your email"}” didn't send. ${message}`, tone: "alert", duration: 15_000 });
    },
    [openComposer, showToast],
  );

  const deliver = useCallback(
    (id: number, keepalive = false) => {
      const item = outgoing.current.get(id);
      if (!item) return;
      outgoing.current.delete(id);
      window.clearTimeout(item.timer);
      void item.payload.then((payload) =>
        postJson<{ warning: string | null }>("/api/mail/drafts/send", payload, keepalive)
          .then((result) => {
            item.onDelivered?.();
            setSent((count) => count + 1);
            if (result.warning) showToast({ message: result.warning, tone: "alert" });
          })
          .catch((error: SendFailure) => {
            item.onUndone?.();
            const reconnect = reconnectOf(error);
            const covered = reconnect ? flagReconnect(error, { sourceId: payload.sourceId }) && hasReconnectHost() : false;
            showToast({
              message: error.detail?.maybeSent || error.status === 409
                ? error.message
                : reconnect?.email
                  ? `“${payload.subject || "Your email"}” didn't send. Reconnect ${reconnect.email}, then send it again.`
                  : `“${payload.subject || "Your email"}” didn't send. ${error.message}`,
              tone: covered ? "status" : "alert",
              duration: 15_000,
              action: { label: "Open draft", run: () => openComposer({ draft: payloadDraft(payload, error), track: item.track }) },
            });
          }),
        (problem: unknown) => {
          item.onUndone?.();
          handedBack(problem, item.track);
        },
      );
    },
    [openComposer, showToast, handedBack],
  );

  const queueSend = useCallback(
    (payload: Promise<SendPayload>, meta: SendMeta = {}) => {
      const id = ++toastCounter.current;
      const timer = window.setTimeout(() => deliver(id), UNDO_MS);
      outgoing.current.set(id, { payload, timer, ...meta });
      setToasts((current) => [
        ...current.slice(-2),
        {
          id,
          message: "Sent.",
          action: {
            label: "Undo",
            run: () => {
              const item = outgoing.current.get(id);
              if (!item) return;
              window.clearTimeout(item.timer);
              outgoing.current.delete(id);
              item.onUndone?.();
              void item.payload.then(
                (value) => {
                  const draft = payloadDraft(value);
                  if (!item.onReopen?.(draft)) openComposer({ draft, track: item.track });
                },
                (problem: unknown) => {
                  const value = handOverPayload(problem);
                  if (!value) return;
                  const draft = payloadDraft(value);
                  if (!item.onReopen?.(draft)) openComposer({ draft, track: item.track });
                },
              );
            },
          },
        },
      ]);
      toastTimers.current.set(id, window.setTimeout(() => dismiss(id), UNDO_MS));
    },
    [deliver, dismiss, openComposer],
  );

  const scheduleSend = useCallback(
    (payload: Promise<SendPayload>, sendAt: string, detail: string) => {
      showToast({ message: `Scheduled for ${detail}.` });
      void payload.then((value) =>
        postJson<MailDraft>("/api/mail/drafts/schedule", { ...value, sendAt })
          .then(() => setSent((count) => count + 1))
          .catch((error: Error) =>
            showToast({
              message: `Couldn't schedule “${value.subject || "your email"}”. ${error.message}`,
              tone: "alert",
              duration: 15_000,
              action: { label: "Open draft", run: () => openComposer({ draft: payloadDraft(value) }) },
            }),
          ),
        (problem: unknown) => handedBack(problem),
      );
    },
    [openComposer, showToast, handedBack],
  );

  const toastsRef = useRef<ShownToast[]>([]);
  useEffect(() => {
    toastsRef.current = toasts;
  });

  const undoLatest = useCallback(() => {
    const latest = [...toastsRef.current].reverse().find((toast) => toast.action?.label === "Undo");
    if (!latest?.action) return false;
    latest.action.run();
    dismiss(latest.id);
    return true;
  }, [dismiss]);

  useEffect(() => {
    const flush = () => {
      for (const id of [...outgoing.current.keys()]) deliver(id, true);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [deliver]);

  const update = useCallback((key: number, change: Partial<Card>) => {
    setCards((current) => {
      const index = current.findIndex((card) => card.key === key);
      if (index < 0) return current;
      const card = current[index];
      const same = (Object.keys(change) as (keyof Card)[]).every((field) => Object.is(card[field], change[field]));
      if (same) return current;
      const next = [...current];
      next[index] = { ...card, ...change };
      return next;
    });
  }, []);

  const remove = useCallback((key: number) => {
    setCards((current) => current.filter((item) => item.key !== key));
  }, []);

  const bringToFront = useCallback(
    (key: number) => {
      const card = cardsRef.current.find((item) => item.key === key);
      if (card && card.layer !== layers.current) update(key, { layer: ++layers.current });
    },
    [update],
  );

  const value = useMemo(
    () => ({ openComposer, sent, queueSend, scheduleSend, pickLater: setLater, showToast, dismissToast: dismiss, undoLatest }),
    [openComposer, sent, queueSend, scheduleSend, showToast, dismiss, undoLatest],
  );
  const docked = cards.filter((card) => !card.minimised && !card.position);
  const desktop = viewport >= 768;
  const perRow = Math.max(1, Math.floor((viewport - EDGE * 2 + GAP) / (CARD_WIDTH + GAP)));
  const minimised = cards.filter((card) => card.minimised);
  const stacking = [...cards].sort((a, b) => a.layer - b.layer).map((card) => card.key);

  return (
    <ComposerContext.Provider value={value}>
      {children}
      {cards.map((card) => (
        <ComposeCard
          key={card.key}
          card={card}
          index={Math.max(0, docked.length - 1 - docked.indexOf(card))}
          perRow={perRow}
          desktop={desktop}
          sheet={sheet}
          stack={stacking.indexOf(card.key)}
          accounts={accounts ?? NO_ACCOUNTS}
          onChange={update}
          onRemove={remove}
          onFront={bringToFront}
        />
      ))}
      {minimised.length > 0 && (
        <div
          data-compose-tray=""
          className="pointer-events-none fixed right-[calc(env(safe-area-inset-right)+1rem)] bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] z-40 flex max-w-[calc(100vw-2rem)] flex-wrap-reverse justify-end gap-2 max-md:[body:has([data-compose-fab])_&]:bottom-[calc(env(safe-area-inset-bottom)+8.25rem)]"
        >
          {minimised.map((card) => {
            const title = card.title || MODE_LABEL[card.start.mode];
            return (
              <Button
                key={card.key}
                variant="subtle"
                size="md"
                aria-label={`Open ${title}`}
                onClick={() => update(card.key, { minimised: false, layer: ++layers.current })}
                className="border-line-strong bg-popover shadow-overlay pointer-events-auto h-9 max-w-[16rem] gap-2 border px-4 text-[13px] font-normal"
              >
                <span className="bg-primary size-1.5 shrink-0 rounded-full" aria-hidden />
                <span className="truncate">{title}</span>
              </Button>
            );
          })}
        </div>
      )}
      <LaterPicker request={later} onClose={() => setLater(null)} />
      {(notice || toasts.length > 0) && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+5rem)] z-50 flex flex-col items-center gap-2 px-4 max-md:[body:has([data-compose-fab])_&]:bottom-[calc(env(safe-area-inset-bottom)+8.25rem)] max-md:[body:has([data-compose-tray])_&]:bottom-[calc(env(safe-area-inset-bottom)+11rem)]">
          {notice && (
            <p role="status" className="bg-popover border-line-strong shadow-overlay animate-rise-in rounded-full border px-4 py-2 text-[13px]">
              {notice}
            </p>
          )}
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role={toast.tone === "alert" ? "alert" : "status"}
              className="bg-popover border-line-strong shadow-overlay animate-rise-in pointer-events-auto flex max-w-[min(36rem,100%)] items-center gap-3 rounded-full border py-1.5 pr-1.5 pl-4 text-[13px]"
            >
              {toast.extra && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-2.5 min-w-0 shrink"
                  aria-label={toast.extra.label}
                  onClick={() => {
                    toast.extra!.run();
                    dismiss(toast.id);
                  }}
                >
                  <span className={cn("truncate", toast.extra.short && "max-sm:hidden")}>{toast.extra.label}</span>
                  {toast.extra.short && <span className="sm:hidden">{toast.extra.short}</span>}
                </Button>
              )}
              <span className={cn(toast.extra ? "shrink-0 whitespace-nowrap" : "min-w-0", toast.tone === "alert" ? "text-danger" : "text-foreground")}>{toast.message}</span>
              {toast.extra && <span aria-hidden className="w-6 shrink-0" />}
              {toast.action ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    toast.action!.run();
                    dismiss(toast.id);
                  }}
                  title={toast.action.label === "Undo" ? "Undo (Z)" : undefined}
                >
                  {toast.action.label}
                </Button>
              ) : toast.tone === "alert" ? (
                <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
                  <XIcon aria-hidden className="size-3.5" />
                </Button>
              ) : (
                <span aria-hidden className="w-2" />
              )}
            </div>
          ))}
        </div>
      )}
    </ComposerContext.Provider>
  );
}
