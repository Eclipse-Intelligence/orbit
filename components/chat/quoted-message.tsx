"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import Button from "@/components/_ui/button";
import { ChatAvatar, useChat } from "@/components/chat/chat-context";
import { stampWhen } from "@/lib/chat/format";
import { cachedQuote, QUOTE_UNAVAILABLE, quoteView, requestQuote, subscribeQuotes } from "@/lib/chat/quotes";
import { parseChatLocation } from "@/lib/chat/routes";
import { filesTitle } from "@/lib/chat/files";
import type { ChatQuote } from "@/lib/chat/types";

const LOAD_FAILED = "Couldn't load the message.";

export default function QuotedMessage({ id }: { id: string }) {
  const quote = useSyncExternalStore(
    subscribeQuotes,
    () => cachedQuote(id),
    () => undefined,
  );
  const [failedId, setFailedId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void requestQuote(id).then(() => {
      if (live) setFailedId(cachedQuote(id) === undefined ? id : null);
    });
    return () => {
      live = false;
    };
  }, [id, attempt]);

  return <QuoteCard quote={quote} failed={failedId === id} onRetry={() => setAttempt((value) => value + 1)} />;
}

export function QuoteCard({ quote, failed, onRetry }: { quote: ChatQuote | null | undefined; failed: boolean; onRetry: () => void }) {
  const { now, go, discussion } = useChat();
  const view = quoteView(quote, failed);
  if (view === "unavailable") {
    return (
      <div className="caption-style text-subtle border-line-strong max-w-[520px] rounded-[10px] border px-3 py-2.5 text-[13px] italic max-md:max-w-full">
        {QUOTE_UNAVAILABLE}
      </div>
    );
  }
  if (!quote) {
    if (view === "loading") return <div aria-hidden className="bg-surface-raised h-14 max-w-[520px] animate-pulse rounded-[10px] max-md:max-w-full" />;
    return (
      <div className="caption-style text-subtle border-line-strong flex max-w-[520px] items-center gap-2 rounded-[10px] border px-3 py-1.5 max-md:max-w-full">
        <span role="alert" className="min-w-0 flex-1">
          {LOAD_FAILED}
        </span>
        <Button variant="ghost" size="sm" onClick={onRetry} className="hit max-md:h-11">
          Try again
        </Button>
      </div>
    );
  }

  const author = { id: quote.author.id ?? `former:${quote.author.name}`, name: quote.author.name };
  const [path, search = ""] = quote.href.split("?");
  const location = !discussion && path.startsWith("/chat/") ? parseChatLocation(path, search) : null;

  return (
    <Link
      href={quote.href}
      onClick={(event) => {
        if (!location || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        go(location);
      }}
      className="hover:bg-surface-hover focus-visible:ring-ring/60 border-line-strong flex max-w-[520px] flex-col gap-1 rounded-[10px] border px-3 py-2.5 outline-none focus-visible:ring-2 max-md:max-w-full"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
        <ChatAvatar person={author} size="xs" />
        <span className="shrink-0 font-medium">{quote.author.name}</span>
        <span className="text-subtle min-w-0 truncate">
          in {quote.place} · {stampWhen(quote.createdAt, now)}
        </span>
      </span>
      {quote.excerpt && <span className="text-soft line-clamp-3 text-[13.5px] leading-[19px] [overflow-wrap:anywhere]">{quote.excerpt}</span>}
      {quote.files > 0 && <span className="caption-style text-subtle">{quote.excerpt ? `And ${filesTitle(quote.files)}` : `Sent ${filesTitle(quote.files)}`}</span>}
    </Link>
  );
}
