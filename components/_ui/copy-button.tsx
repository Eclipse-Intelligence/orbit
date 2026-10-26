"use client";

import { useEffect, useState } from "react";
import Button from "@/components/_ui/button";
import { cn } from "@/lib/utils";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import CopyIcon from "@/public/assets/images/booking/copy.svg";

export default function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  variant = "secondary",
  className,
  disabled,
}: {
  text: string | (() => string | Promise<string>);
  label?: string;
  copiedLabel?: string;
  variant?: "secondary" | "ghost";
  className?: string;
  disabled?: boolean;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      const value = typeof text === "function" ? await text() : text;
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  const copied = state === "copied";
  return (
    <Button variant={variant} size="sm" disabled={disabled} className={cn("min-w-[5.5rem]", className)} onClick={() => void copy()}>
      <span aria-hidden className="relative size-3">
        <CopyIcon className={cn("absolute inset-0 size-3 transition-[opacity,scale,filter] duration-150 ease-power3-out", copied ? "scale-25 opacity-0 blur-[4px]" : "scale-100 opacity-100 blur-0")} />
        <CheckIcon className={cn("text-success absolute inset-0 size-3 transition-[opacity,scale,filter] duration-150 ease-power3-out", copied ? "scale-100 opacity-100 blur-0" : "scale-25 opacity-0 blur-[4px]")} />
      </span>
      <span role="status">{copied ? copiedLabel : state === "failed" ? "Couldn't copy" : label}</span>
    </Button>
  );
}
