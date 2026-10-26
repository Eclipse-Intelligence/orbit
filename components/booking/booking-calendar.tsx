"use client";

import { useRef, type KeyboardEvent } from "react";
import Button from "@/components/_ui/button";
import { dayTitle, monthGrid, monthTitle, WEEKDAY_INITIALS } from "@/lib/booking/format";
import { cn } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";

const MOVES: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

export default function BookingCalendar({
  month,
  days,
  loading,
  selected,
  today,
  canPrev,
  canNext,
  onMonth,
  onSelect,
}: {
  month: string;
  days: Record<string, string[]>;
  loading: boolean;
  selected: string | null;
  today: string;
  canPrev: boolean;
  canNext: boolean;
  onMonth: (step: number) => void;
  onSelect: (key: string) => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const cells = monthGrid(month);
  const open = cells.filter((cell) => cell.inMonth && days[cell.key]?.length);
  const focusKey = selected && days[selected]?.length ? selected : open[0]?.key;

  function move(event: KeyboardEvent<HTMLButtonElement>, key: string) {
    const step = MOVES[event.key];
    if (step === undefined && event.key !== "Home" && event.key !== "End") return;
    const enabled = [...(grid.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (enabled.length === 0) return;
    event.preventDefault();
    let target: HTMLButtonElement | undefined;
    if (event.key === "Home") target = enabled[0];
    else if (event.key === "End") target = enabled[enabled.length - 1];
    else {
      const keys = enabled.map((button) => button.dataset.day ?? "");
      const index = cells.findIndex((cell) => cell.key === key);
      for (let next = index + step; next >= 0 && next < cells.length; next += step) {
        const found = keys.indexOf(cells[next].key);
        if (found >= 0) {
          target = enabled[found];
          break;
        }
      }
    }
    target?.focus();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="booking-month" aria-live="polite" suppressHydrationWarning className="text-[15px] leading-5 font-medium">
          {monthTitle(month)}
        </h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous month"
            disabled={!canPrev}
            onClick={() => onMonth(-1)}
            className="text-soft hover:text-foreground"
          >
            <ChevronLeftIcon aria-hidden className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Next month"
            disabled={!canNext}
            onClick={() => onMonth(1)}
            className="text-soft hover:text-foreground"
          >
            <ChevronRightIcon aria-hidden className="size-3.5" />
          </Button>
        </div>
      </div>
      <div
        ref={grid}
        role="group"
        aria-labelledby="booking-month"
        aria-busy={loading}
        className="grid grid-cols-7 gap-y-1 text-center"
      >
        {WEEKDAY_INITIALS.map((label) => (
          <span key={label} aria-hidden className="caption-style text-subtle pb-2 uppercase tracking-[0.06em]">
            {label.slice(0, 2)}
          </span>
        ))}
        {cells.map((cell) => {
          if (!cell.inMonth) return <span key={cell.key} aria-hidden />;
          const count = days[cell.key]?.length ?? 0;
          const active = selected === cell.key;
          const available = count > 0 && !loading;
          const date = Number(cell.key.slice(8));
          return (
            <div key={cell.key} className="flex justify-center">
              <button
                type="button"
                data-day={cell.key}
                disabled={!available}
                aria-pressed={available ? active : undefined}
                aria-current={cell.key === today ? "date" : undefined}
                aria-label={`${dayTitle(cell.key)}, ${count === 0 ? "no times" : `${count} time${count === 1 ? "" : "s"} available`}`}
                tabIndex={cell.key === focusKey ? 0 : -1}
                onClick={() => onSelect(cell.key)}
                onKeyDown={(event) => move(event, cell.key)}
                className={cn(
                  "focus-visible:ring-ring/80 relative flex size-10 cursor-pointer items-center justify-center rounded-full text-[14px] leading-none tabular-nums transition-[background-color,color,box-shadow] duration-150 ease-power3-out outline-none focus-visible:ring-2 disabled:cursor-default",
                  available && !active && "bg-white/[0.07] font-medium text-foreground hover:bg-white/[0.14]",
                  !available && "text-white/45",
                  active &&
                    "bg-primary font-semibold text-white shadow-[0px_4px_14px_0px_rgba(65,36,251,0.45),inset_0px_1px_0px_0px_rgba(255,255,255,0.2)]",
                  loading && "animate-pulse",
                )}
              >
                {date}
                {cell.key === today && (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute bottom-1.5 left-1/2 size-1 -translate-x-1/2 rounded-full",
                      active ? "bg-white" : "bg-primary",
                    )}
                  />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
