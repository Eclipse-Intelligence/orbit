"use client";

import type { AskResult } from "@/components/mail/mail-cache";
import Button from "@/components/_ui/button";
import { mailFullWhen, mailListWhen } from "@/lib/mail/format";
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
          <div role="status" aria-busy="true" className="flex flex-col gap-2 py-1">
            <span className="sr-only">Reading your email…</span>
            <span aria-hidden className="bg-surface-active h-2.5 w-11/12 animate-pulse rounded-full" />
            <span aria-hidden className="bg-surface-raised h-2.5 w-2/3 animate-pulse rounded-full" />
          </div>
        )}
      </div>
      {ask.result && ask.result.sources.length > 0 && (
        <ul aria-label="Emails the answer came from" className="flex flex-col gap-px">
          {ask.result.sources.map((source) => (
            <li key={source.key}>
              <Button
                variant="item"
                size="none"
                onClick={() => onOpen(source.key)}
                className="hover:bg-surface-hover flex-col gap-0.5 rounded-xl px-3 py-2 leading-[1.4] active:scale-100"
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="text-soft min-w-0 truncate text-[14px]">{source.from}</span>
                  <time dateTime={source.at ?? undefined} title={mailFullWhen(source.at)} className="text-subtle ml-auto shrink-0 text-[12px] tabular-nums">
                    {mailListWhen(source.at, now)}
                  </time>
                </span>
                <span className="text-subtle w-full truncate text-[13px]">{source.subject || "(no subject)"}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
