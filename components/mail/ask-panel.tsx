"use client";

import type { AskResult } from "@/components/mail/mail-cache";
import { mailListWhen } from "@/lib/mail/format";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";

export type AskState = { question: string; result: AskResult | null; error: string | null };

export default function AskPanel({ ask, now, onOpen }: { ask: AskState; now: number; onOpen: (key: string) => void }) {
  return (
    <section aria-label="Answer from your email" className="flex flex-col gap-3 px-3 pt-1 pb-6">
      <div className="rounded-xl bg-[color-mix(in_srgb,var(--primary)_9%,transparent)] px-3.5 py-3">
        <p className="caption-style text-subtle flex items-center gap-1.5 pb-1.5">
          <SparkleIcon aria-hidden className={ask.result || ask.error ? "text-primary-foreground size-3" : "text-primary-foreground size-3 animate-pulse"} />
          {ask.question}
        </p>
        {ask.error ? (
          <p role="alert" className="text-danger text-[14px]">
            {ask.error}
          </p>
        ) : ask.result ? (
          <p role="status" className="text-foreground text-[14px] leading-6 text-pretty">
            {ask.result.answer}
          </p>
        ) : (
          <div role="status" aria-label="Reading your email" className="flex flex-col gap-2 py-1">
            <span className="h-2.5 w-11/12 animate-pulse rounded-full bg-white/[0.07]" />
            <span className="h-2.5 w-2/3 animate-pulse rounded-full bg-white/[0.05]" />
          </div>
        )}
      </div>
      {ask.result && ask.result.sources.length > 0 && (
        <ul aria-label="Emails the answer came from" className="flex flex-col gap-px">
          {ask.result.sources.map((source) => (
            <li key={source.key}>
              <button
                type="button"
                onClick={() => onOpen(source.key)}
                className="ease-power3-out flex w-full cursor-pointer flex-col gap-0.5 rounded-xl px-3 py-2 text-left transition-colors duration-150 outline-none hover:bg-white/[0.035] focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="text-soft min-w-0 truncate text-[14px]">{source.from}</span>
                  <span className="text-subtle ml-auto shrink-0 text-[12px] tabular-nums">{mailListWhen(source.at, now)}</span>
                </span>
                <span className="text-subtle truncate text-[13px]">{source.subject || "(no subject)"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
