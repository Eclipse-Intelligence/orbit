"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import { cn } from "@/lib/utils";

const HOLD_MS = 800;

export default function HoldButton({
  onConfirm,
  children,
  holding = "Keep holding",
  tone = "danger",
  disabled,
  className,
  size = "sm",
}: {
  onConfirm: () => void;
  children: ReactNode;
  holding?: string;
  tone?: "danger" | "neutral";
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
}) {
  const [active, setActive] = useState(false);
  const timer = useRef<number | null>(null);

  function stop() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setActive(false);
  }

  function start() {
    if (disabled || timer.current !== null) return;
    setActive(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setActive(false);
      onConfirm();
    }, HOLD_MS);
  }

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
      event.preventDefault();
      start();
    }
  }

  function onKeyUp(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Enter" || event.key === " ") stop();
  }

  return (
    <Button
      variant="secondary"
      size={size}
      disabled={disabled}
      aria-live="polite"
      className={cn("relative touch-none overflow-hidden select-none", tone === "danger" && "text-danger", className)}
      onPointerDown={(event) => {
        if (event.button === 0) start();
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={stop}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 origin-left scale-x-0 rounded-[inherit]",
          tone === "danger" ? "bg-danger/25" : "bg-white/15",
          active ? "scale-x-100 transition-transform ease-linear" : "transition-transform duration-150 ease-power3-out",
        )}
        style={active ? { transitionDuration: `${HOLD_MS}ms` } : undefined}
      />
      <span className="relative">{active ? holding : children}</span>
    </Button>
  );
}
