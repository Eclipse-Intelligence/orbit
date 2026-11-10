"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import { swipeCommit, watchSwipe, type SwipeHandlers } from "@/components/mail/swipe";
import type { SnoozeChoice } from "@/lib/crm/task-snooze";
import { KEYBOARD_ROW_CLASS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { focusOnPage, useReleaseFocusOnUnmount } from "@/stores/page-context-store";
import ArchiveIcon from "@/public/assets/images/mail/archive.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import MoreIcon from "@/public/assets/images/_common/more.svg";

export type MenuItem = { id: string; label: string; run: () => void };

export type RowAction = {
  id: string;
  label: string;
  variant: "primary" | "secondary" | "subtle" | "ghost";
  run?: () => void;
  key?: string;
  hint?: string;
  opens?: boolean;
  phoneMore?: boolean;
  disabled?: boolean;
  snooze?: {
    choices: () => SnoozeChoice[];
    pick: (choice: SnoozeChoice) => void;
    extra?: MenuItem[];
  };
  render?: (hint: string[] | undefined) => ReactNode;
};

export type RowSwipe = {
  left?: { label: string; run: () => void };
  right?: () => void;
};

export type CaptureList = { leaving: ReadonlySet<string>; swiped: (id: string) => void };

export const CaptureListContext = createContext<CaptureList>({ leaving: new Set(), swiped: () => undefined });

export const COLLAPSE_MS = 220;
const OUT_MS = 180;

function SnoozeItems({ choices, pick, extra }: { choices: SnoozeChoice[]; pick: (choice: SnoozeChoice) => void; extra?: MenuItem[] }) {
  return (
    <>
      <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
      {choices.map((choice) => (
        <DropdownMenuItem key={choice.id} className="max-sm:py-2.5" onSelect={() => pick(choice)}>
          {choice.label}
          <span className="text-subtle ml-auto pl-4 tabular-nums">{choice.detail}</span>
        </DropdownMenuItem>
      ))}
      {extra && extra.length > 0 && <DropdownMenuSeparator />}
      {extra?.map((item) => (
        <DropdownMenuItem key={item.id} className="max-sm:py-2.5" onSelect={item.run}>
          {item.label}
        </DropdownMenuItem>
      ))}
    </>
  );
}

function SnoozeButton({ action, hint }: { action: RowAction & { snooze: NonNullable<RowAction["snooze"]> }; hint: string[] | undefined }) {
  const [choices, setChoices] = useState<SnoozeChoice[]>([]);
  return (
    <DropdownMenu modal={false} onOpenChange={(open) => open && setChoices(action.snooze.choices())}>
      <DropdownMenuTrigger asChild>
        <Button
          variant={action.variant}
          size="sm"
          className={cn(action.phoneMore && "max-sm:hidden")}
          data-row-key={action.key}
          title={action.hint ? `${action.label} (${action.hint})` : undefined}
          shortcut={hint}
          disabled={action.disabled}
        >
          <ClockIcon aria-hidden className="size-3" />
          {action.label}
          <ChevronDownIcon aria-hidden className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        <SnoozeItems choices={choices} pick={action.snooze.pick} extra={action.snooze.extra} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MoreMenu({ actions, extra }: { actions: RowAction[]; extra: MenuItem[] }) {
  const [choices, setChoices] = useState<SnoozeChoice[]>([]);
  const snoozeAction = actions.find((action) => action.snooze);
  const snooze = snoozeAction?.snooze;
  const plain = actions.filter((action) => !action.snooze && action.run);
  return (
    <DropdownMenu modal={false} onOpenChange={(open) => open && snooze && setChoices(snooze.choices())}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="More actions" className="ml-auto sm:hidden" data-row-key={snoozeAction?.key}>
          <MoreIcon aria-hidden className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        {plain.map((action) => (
          <DropdownMenuItem key={action.id} className="max-sm:py-2.5" disabled={action.disabled} onSelect={() => action.run?.()}>
            {action.label}
          </DropdownMenuItem>
        ))}
        {extra.map((item) => (
          <DropdownMenuItem key={item.id} className="max-sm:py-2.5" onSelect={item.run}>
            {item.label}
          </DropdownMenuItem>
        ))}
        {snooze && (plain.length > 0 || extra.length > 0) && <DropdownMenuSeparator />}
        {snooze && <SnoozeItems choices={choices} pick={snooze.pick} extra={snooze.extra} />}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PhoneKeys({ actions }: { actions: RowAction[] }) {
  const keyed = actions.filter((action) => action.phoneMore && action.key && action.run && !action.snooze && !action.disabled);
  if (keyed.length === 0) return null;
  return (
    <span aria-hidden className="sm:hidden">
      {keyed.map((action) => (
        <button key={action.id} type="button" tabIndex={-1} data-row-key={action.key} className="sr-only" onClick={action.run}>
          {action.label}
        </button>
      ))}
    </span>
  );
}

export default function CaptureRow({
  rowId,
  mark,
  title,
  titleHref,
  badge,
  when,
  meta,
  chips,
  detail,
  actions,
  more = [],
  swipe,
  below,
}: {
  rowId: string;
  mark: ReactNode;
  title: string;
  titleHref?: string;
  badge?: ReactNode;
  when?: string | null;
  meta?: ReactNode;
  chips?: ReactNode;
  detail?: ReactNode;
  actions: RowAction[];
  more?: MenuItem[];
  swipe?: RowSwipe;
  below?: ReactNode;
}) {
  const list = useContext(CaptureListContext);
  const leaving = list.leaving.has(rowId);
  const [active, setActive] = useState(false);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  const [width, setWidth] = useState(360);
  const row = useRef<HTMLLIElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const handlers = useRef<SwipeHandlers>({});
  const armedBefore = useRef(false);
  const timers = useRef<number[]>([]);
  const allowed = { left: Boolean(swipe?.left), right: Boolean(swipe?.right) };
  const armed = offset !== 0 && swipeCommit(offset, 0, width, allowed) !== null;
  const phoneMore = actions.filter((action) => action.phoneMore);
  const hasMore = phoneMore.length > 0 || more.length > 0;
  const closing = leaving || height !== null;
  useReleaseFocusOnUnmount("capture", rowId);

  useEffect(() => {
    if (!leaving) return;
    const element = row.current;
    if (!element) return;
    const frames: number[] = [];
    setHeight((current) => current ?? element.offsetHeight);
    frames.push(window.requestAnimationFrame(() => frames.push(window.requestAnimationFrame(() => setHeight(0)))));
    return () => {
      frames.forEach((frame) => window.cancelAnimationFrame(frame));
      setHeight(null);
    };
  }, [leaving]);

  useEffect(() => {
    const later = (run: () => void, ms: number) => timers.current.push(window.setTimeout(run, ms));
    handlers.current = {
      canLeft: allowed.left && !closing,
      canRight: allowed.right && !closing,
      scroller: () => row.current?.closest<HTMLElement>(".overflow-y-auto") ?? null,
      width: () => row.current?.offsetWidth ?? window.innerWidth,
      onDrag: (dx) => {
        if (!swipe || closing) return;
        const rowWidth = row.current?.offsetWidth ?? 360;
        setWidth(rowWidth);
        setDragging(true);
        const nowArmed = swipeCommit(dx, 0, rowWidth, allowed) !== null;
        if (nowArmed && !armedBefore.current) navigator.vibrate?.(8);
        armedBefore.current = nowArmed;
        setOffset(dx);
      },
      onRelease: (commit) => {
        armedBefore.current = false;
        setDragging(false);
        if (!swipe || !commit) {
          setOffset(0);
          return;
        }
        if (commit === "left" && swipe.left) {
          const left = swipe.left;
          setOffset(-(row.current?.offsetWidth ?? width));
          later(() => {
            setHeight(row.current?.offsetHeight ?? 64);
            window.requestAnimationFrame(() => window.requestAnimationFrame(() => setHeight(0)));
          }, OUT_MS);
          later(() => {
            list.swiped(rowId);
            left.run();
            setHeight(null);
            setOffset(0);
          }, OUT_MS + COLLAPSE_MS);
          return;
        }
        setOffset(0);
        swipe.right?.();
      },
    };
  });

  useEffect(() => {
    const element = body.current;
    const pending = timers.current;
    const stop = element && swipe ? watchSwipe(element, () => handlers.current) : undefined;
    return () => {
      stop?.();
      pending.forEach((timer) => window.clearTimeout(timer));
    };
  }, [swipe]);

  const hintFor = (action: RowAction) => (active && action.hint ? [action.hint] : undefined);
  const titleNode = titleHref ? (
    <Link
      href={titleHref}
      data-row-open={actions.some((action) => action.opens) ? undefined : ""}
      className="min-w-0 text-[14px] leading-5 break-words hover:underline hover:decoration-white/30 hover:underline-offset-2 sm:truncate"
    >
      {title}
    </Link>
  ) : (
    <span className="min-w-0 text-[14px] leading-5 break-words sm:truncate">{title}</span>
  );

  return (
    <li
      ref={row}
      data-list-row=""
      data-capture-row={rowId}
      data-leaving={leaving ? "" : undefined}
      onFocus={(event) => {
        focusOnPage("capture", rowId);
        if (event.target === event.currentTarget) setActive(true);
      }}
      onPointerDown={() => focusOnPage("capture", rowId)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(false);
      }}
      className={cn(
        KEYBOARD_ROW_CLASS,
        "relative overflow-hidden",
        height !== null && "ease-power3-in-out transition-[height,opacity] duration-200",
        closing && "pointer-events-none",
      )}
      style={height !== null ? { height, opacity: height === 0 ? 0 : 1 } : undefined}
    >
      {offset !== 0 && swipe && (
        <span
          aria-hidden
          className={cn(
            "ease-power3-out absolute inset-0 flex items-center px-5 text-[13px] font-medium transition-colors duration-150",
            offset < 0 ? "justify-end" : "justify-start",
            !armed ? "text-soft bg-white/[0.06]" : offset < 0 ? "bg-[color-mix(in_srgb,var(--success)_78%,black)] text-white" : "bg-primary text-white",
          )}
        >
          <span
            className={cn(
              "ease-power3-out flex items-center gap-2 transition-transform duration-150",
              armed ? "scale-100" : "scale-90",
              offset < 0 && "flex-row-reverse",
            )}
          >
            {offset < 0 ? <ArchiveIcon className="size-[18px]" /> : <ClockIcon className="size-[18px]" />}
            {offset < 0 ? swipe.left?.label : "Snooze"}
          </span>
        </span>
      )}
      <div
        ref={body}
        className={cn("relative flex touch-pan-y flex-col", offset !== 0 && "bg-card", dragging ? "transition-none" : "ease-power3-out transition-transform duration-200")}
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
      >
        <div className="flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            {mark}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex min-w-0 items-baseline gap-2">
                {titleNode}
                {badge && <span className="shrink-0 self-center">{badge}</span>}
                {when && <span className="caption-style text-subtle ml-auto shrink-0 pl-1 tabular-nums">{when}</span>}
              </span>
              {meta && <span className="caption-style text-subtle truncate leading-[1.4]">{meta}</span>}
              {chips}
              {detail}
            </div>
          </div>
          {!below && (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 max-sm:pl-[34px]">
              {actions.map((action) =>
                action.render ? (
                  <span key={action.id} className={cn("contents", action.phoneMore && "max-sm:hidden")}>
                    {action.render(hintFor(action))}
                  </span>
                ) : action.snooze ? (
                  <SnoozeButton
                    key={action.id}
                    action={
                      action as RowAction & {
                        snooze: NonNullable<RowAction["snooze"]>;
                      }
                    }
                    hint={hintFor(action)}
                  />
                ) : (
                  <Button
                    key={action.id}
                    variant={action.variant}
                    size="sm"
                    className={cn("max-w-full", action.phoneMore && "max-sm:hidden")}
                    data-row-key={action.key}
                    data-row-open={action.opens ? "" : undefined}
                    title={action.hint ? `${action.label} (${action.hint})` : undefined}
                    shortcut={hintFor(action)}
                    disabled={action.disabled}
                    onClick={action.run}
                  >
                    <span className="truncate">{action.label}</span>
                  </Button>
                ),
              )}
              <PhoneKeys actions={actions} />
              {hasMore && <MoreMenu actions={phoneMore} extra={more} />}
            </div>
          )}
        </div>
        {below && <div className="px-4 pb-3 sm:pl-[50px]">{below}</div>}
      </div>
    </li>
  );
}
