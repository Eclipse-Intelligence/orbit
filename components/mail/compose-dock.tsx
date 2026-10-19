"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import MailComposer, { MODE_LABEL, type ComposerStart } from "@/components/mail/mail-composer";
import { emailRecipientAction } from "@/app/(crm)/quick-add";
import type { MailAddress } from "@/lib/mail/types";
import type { ComposeAccount, MailDraft } from "@/lib/mail/view";
import { cn } from "@/lib/utils";

const MAX_CARDS = 6;
const CARD_WIDTH = 544;
const GAP = 12;
const EDGE = 16;

type Card = {
  key: number;
  start: ComposerStart;
  title: string;
  minimised: boolean;
  position: { x: number; y: number } | null;
  layer: number;
};

type OpenOptions = { to?: MailAddress[]; contactId?: string | null; draft?: MailDraft };

type ComposerContextValue = {
  openComposer: (options?: OpenOptions) => void;
  sent: number;
};

const ComposerContext = createContext<ComposerContextValue | null>(null);

export function useComposer() {
  const value = useContext(ComposerContext);
  if (!value) throw new Error("useComposer needs a ComposerProvider");
  return value;
}

async function loadAccounts(): Promise<ComposeAccount[]> {
  const response = await fetch("/api/mail/accounts", { cache: "no-store" });
  if (!response.ok) return [];
  const body = (await response.json()) as { accounts: ComposeAccount[] };
  return body.accounts;
}

function ComposeCard({
  card,
  index,
  perRow,
  desktop,
  accounts,
  onChange,
  onRemove,
  onFront,
  onSent,
}: {
  card: Card;
  index: number;
  perRow: number;
  desktop: boolean;
  accounts: ComposeAccount[];
  onChange: (change: Partial<Card>) => void;
  onRemove: () => void;
  onFront: () => void;
  onSent: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; dx: number; dy: number } | null>(null);
  const setTitle = useCallback((subject: string) => onChange({ title: subject.trim() }), [onChange]);

  function down(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button") || !desktop) return;
    const rect = element.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = { pointer: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    onFront();
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    const rect = element.current?.getBoundingClientRect();
    if (!state || state.pointer !== event.pointerId || !rect) return;
    const x = Math.min(Math.max(EDGE / 2, event.clientX - state.dx), window.innerWidth - rect.width - EDGE / 2);
    const y = Math.min(Math.max(EDGE / 2, event.clientY - state.dy), window.innerHeight - 56);
    onChange({ position: { x, y } });
  }

  function up(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointer === event.pointerId) drag.current = null;
  }

  const title = card.title || MODE_LABEL[card.start.mode];
  const column = index % perRow;
  const row = Math.floor(index / perRow);
  const placed = !desktop
    ? {}
    : card.position
      ? { left: card.position.x, top: card.position.y }
      : { right: EDGE + column * (CARD_WIDTH + GAP) + row * 28, bottom: EDGE + row * 28 };

  return (
    <div
      ref={element}
      role="dialog"
      aria-label={title}
      onPointerDownCapture={onFront}
      className={cn(
        "border-line-strong bg-popover shadow-overlay animate-rise-in pointer-events-auto fixed flex flex-col overflow-hidden rounded-2xl border",
        "inset-x-2 bottom-2 max-h-[85dvh] md:inset-x-auto md:bottom-auto md:w-[34rem] md:max-h-[min(42rem,calc(100dvh-2rem))]",
        card.minimised && "hidden",
      )}
      style={{ ...placed, zIndex: 40 + card.layer }}
    >
      <div
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className="flex shrink-0 cursor-default items-center gap-2 py-2 pr-2 pl-4 select-none md:cursor-grab md:active:cursor-grabbing"
      >
        <span className="text-foreground min-w-0 flex-1 truncate text-[13px] font-medium">{title}</span>
        <Button variant="ghost" size="icon-sm" aria-label={`Minimise ${title}`} title="Minimise" onClick={() => onChange({ minimised: true })}>
          <svg aria-hidden width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M5 12h14" />
          </svg>
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Close ${title}, keeping the draft`} title="Close (the draft stays in Outlook)" onClick={onRemove}>
          <svg aria-hidden width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M6 6 18 18M18 6 6 18" />
          </svg>
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {accounts.length === 0 ? (
          <p className="caption-style text-subtle px-4 pb-4">Connect Microsoft in Capture to send email from Orbit.</p>
        ) : (
          <MailComposer
            start={card.start}
            accounts={accounts}
            variant="card"
            onSubject={setTitle}
            onClose={onRemove}
            onSent={() => {
              onSent();
              onRemove();
            }}
          />
        )}
      </div>
    </div>
  );
}

export function ComposerProvider({ children }: { children: ReactNode }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [accounts, setAccounts] = useState<ComposeAccount[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const [viewport, setViewport] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  const cardsRef = useRef<Card[]>([]);
  const counter = useRef(0);
  const layers = useRef(0);
  const accountsRequest = useRef<Promise<ComposeAccount[]> | null>(null);

  useEffect(() => {
    cardsRef.current = cards;
  });

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
    if (!accountsRequest.current) accountsRequest.current = loadAccounts().catch(() => []);
    void (async () => {
      const [list, contact] = await Promise.all([
        accountsRequest.current!,
        options.contactId ? emailRecipientAction(options.contactId).catch(() => null) : Promise.resolve(null),
      ]);
      setAccounts(list);
      const to = options.to ?? (contact?.email ? [{ address: contact.email.toLowerCase(), name: contact.name }] : []);
      const start: ComposerStart = {
        mode: options.draft?.mode ?? "new",
        messageId: options.draft?.messageId ?? null,
        sourceId: options.draft?.sourceId ?? list[0]?.id ?? "",
        to,
        cc: [],
        subject: "",
        draft: options.draft ?? null,
      };
      const existing = options.draft ? cardsRef.current.find((card) => card.start.draft?.id === options.draft!.id) : null;
      if (existing) {
        const layer = ++layers.current;
        setCards((current) => current.map((card) => (card.key === existing.key ? { ...card, minimised: false, layer } : card)));
        return;
      }
      if (cardsRef.current.length >= MAX_CARDS) {
        setNotice(`Up to ${MAX_CARDS} emails can be open at once. Send or close one first.`);
        return;
      }
      counter.current += 1;
      const card: Card = { key: counter.current, start, title: options.draft?.subject ?? "", minimised: false, position: null, layer: ++layers.current };
      cardsRef.current = [...cardsRef.current, card];
      setCards((current) => [...current, card]);
    })();
  }, []);

  const update = useCallback((key: number, change: Partial<Card>) => {
    setCards((current) => current.map((card) => (card.key === key ? { ...card, ...change } : card)));
  }, []);

  const value = useMemo(() => ({ openComposer, sent }), [openComposer, sent]);
  const docked = cards.filter((card) => !card.minimised && !card.position);
  const desktop = viewport >= 768;
  const perRow = Math.max(1, Math.floor((viewport - EDGE * 2 + GAP) / (CARD_WIDTH + GAP)));
  const minimised = cards.filter((card) => card.minimised);

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
          accounts={accounts ?? []}
          onChange={(change) => update(card.key, change)}
          onRemove={() => setCards((current) => current.filter((item) => item.key !== card.key))}
          onFront={() => {
            if (card.layer !== layers.current) update(card.key, { layer: ++layers.current });
          }}
          onSent={() => {
            setSent((count) => count + 1);
            setNotice("Sent.");
          }}
        />
      ))}
      {minimised.length > 0 && (
        <div className="pointer-events-none fixed right-4 bottom-4 z-40 flex max-w-[calc(100vw-2rem)] flex-wrap-reverse justify-end gap-2">
          {minimised.map((card) => (
            <button
              key={card.key}
              type="button"
              onClick={() => update(card.key, { minimised: false, layer: ++layers.current })}
              className="border-line-strong bg-popover shadow-overlay text-foreground pointer-events-auto flex h-9 max-w-[16rem] cursor-pointer items-center gap-2 rounded-full border px-4 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <span className="bg-primary size-1.5 shrink-0 rounded-full" aria-hidden />
              <span className="truncate">{card.title || MODE_LABEL[card.start.mode]}</span>
            </button>
          ))}
        </div>
      )}
      {notice && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
          <p role="status" className="bg-popover border-line-strong shadow-overlay animate-rise-in rounded-full border px-4 py-2 text-[13px]">
            {notice}
          </p>
        </div>
      )}
    </ComposerContext.Provider>
  );
}
