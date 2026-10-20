"use client";

import { useId, useState, type KeyboardEvent } from "react";
import Button from "@/components/_ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/_ui/dialog";
import type { LaterOption } from "@/lib/mail/later";
import { laterDetail } from "@/lib/mail/later";
import { parseDateTime } from "@/lib/time";

export type LaterRequest = { title: string; description: string; options: LaterOption[]; now: number; onPick: (at: string, detail: string) => void };

export default function LaterPicker({ request, onClose }: { request: LaterRequest | null; onClose: () => void }) {
  const id = useId();
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);

  function pick(at: string) {
    if (!request) return;
    request.onPick(at, laterDetail(at, request.now));
    setCustom("");
    setError(null);
    onClose();
  }

  function pickCustom() {
    const date = parseDateTime(custom);
    if (!date || !request || date.getTime() < request.now + 60_000) {
      setError("Choose a time at least a minute from now.");
      return;
    }
    pick(date.toISOString());
  }

  function move(event: KeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }

  return (
    <Dialog
      open={Boolean(request)}
      onOpenChange={(open) => {
        if (!open) {
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-[360px]">
        <div className="flex flex-col gap-1 px-5 pt-5 pb-3">
          <DialogTitle className="text-[15px] font-medium">{request?.title}</DialogTitle>
          <DialogDescription>{request?.description}</DialogDescription>
        </div>
        <ul aria-label="Times" onKeyDown={move} className="flex flex-col px-2">
          {request?.options.map((option, index) => (
            <li key={option.id}>
              <button
                type="button"
                autoFocus={index === 0}
                onClick={() => pick(option.at)}
                className="ease-power3-out flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-[14px] transition-colors duration-150 outline-none hover:bg-white/[0.05] focus-visible:bg-white/[0.07]"
              >
                <span className="text-foreground">{option.label}</span>
                <span className="text-subtle tabular-nums">{option.detail}</span>
              </button>
            </li>
          ))}
        </ul>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            pickCustom();
          }}
          className="flex items-center gap-2 px-5 pt-2 pb-5"
        >
          <label htmlFor={`${id}-custom`} className="sr-only">
            Pick a date and time
          </label>
          <input
            id={`${id}-custom`}
            type="datetime-local"
            value={custom}
            onChange={(event) => {
              setCustom(event.target.value);
              setError(null);
            }}
            className="text-foreground h-9 min-w-0 flex-1 rounded-lg bg-white/[0.05] px-3 text-[14px] outline-none [color-scheme:dark] focus-visible:ring-2 focus-visible:ring-ring/60"
          />
          <Button variant="secondary" type="submit" disabled={!custom}>
            Set
          </Button>
        </form>
        {error && (
          <p role="alert" className="caption-style text-danger -mt-3 px-5 pb-4">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
