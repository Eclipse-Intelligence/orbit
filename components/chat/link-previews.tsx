"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { removeLinkPreviewAction } from "@/app/(crm)/chat/actions";
import Button from "@/components/_ui/button";
import { echoChatEvent } from "@/components/chat/chat-live";
import { shortDate } from "@/lib/chat/format";
import { recordRefs, type ChatRecordCard } from "@/lib/chat/links";
import { loadRecordCards, recordKey, refsFromKey } from "@/lib/chat/record-cards";
import type { ChatLinkPreview, ChatMessage } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import GlobeIcon from "@/public/assets/images/booking/globe.svg";
import RemoveIcon from "@/public/assets/images/chat/remove.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";

const REMOVE_FAILED = "Couldn't remove the preview. Try again.";
const KIND_LABELS: Record<ChatRecordCard["kind"], string> = { company: "Company", contact: "Contact", opportunity: "Opportunity", task: "Task", doc: "Doc" };

const noSubscription = () => () => {};

function useOrbitOrigin() {
  return useSyncExternalStore(
    noSubscription,
    () => window.location.origin,
    () => null,
  );
}

function initials(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
}

function CardTile({ card }: { card: ChatRecordCard }) {
  return (
    <span aria-hidden className="bg-surface-active text-soft grid size-8 shrink-0 place-items-center rounded-lg text-[12px] font-semibold">
      {card.kind === "task" ? <CheckIcon className="size-3.5" /> : card.kind === "doc" ? <DocIcon className="size-3.5" /> : initials(card.kind === "opportunity" && card.subtitle ? card.subtitle : card.title)}
    </span>
  );
}

function RecordCardLink({ card }: { card: ChatRecordCard }) {
  const label = KIND_LABELS[card.kind];
  return (
    <Link
      href={card.href}
      aria-label={`${label}: ${card.title}`}
      className="bg-surface-raised hover:bg-surface-active focus-visible:ring-ring/60 flex max-w-[420px] min-w-0 items-center gap-3 rounded-[10px] px-3 py-2.5 outline-none focus-visible:ring-2 max-md:max-w-full"
    >
      <CardTile card={card} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="caption-style text-subtle">{label}</span>
        <span className="truncate text-[14px]">{card.title}</span>
        {card.subtitle && <span className="caption-style text-subtle truncate">{card.subtitle}</span>}
      </span>
      {(card.pill || card.dueAt) && (
        <span className="bg-surface-active text-soft inline-flex h-5 shrink-0 items-center rounded-full px-[7px] text-[11.5px]">{card.pill ?? `Due ${shortDate(card.dueAt!)}`}</span>
      )}
      {card.figure && <span className="text-subtle shrink-0 text-[12.5px] tabular-nums">{card.figure}</span>}
    </Link>
  );
}

function RecordCards({ message, origin }: { message: ChatMessage; origin: string }) {
  const key = useMemo(() => recordRefs(message.body, message.format, origin).map(recordKey).join(","), [message.body, message.format, origin]);
  const [shown, setShown] = useState<{ key: string; cards: ChatRecordCard[] }>({ key: "", cards: [] });
  useEffect(() => {
    if (!key) return;
    let live = true;
    void loadRecordCards(refsFromKey(key)).then((cards) => {
      if (live) setShown({ key, cards });
    });
    return () => {
      live = false;
    };
  }, [key]);
  if (shown.key !== key || shown.cards.length === 0) return null;
  return (
    <div className="mt-0.5 flex flex-col gap-1.5">
      {shown.cards.map((card) => (
        <RecordCardLink key={`${card.kind}:${card.id}`} card={card} />
      ))}
    </div>
  );
}

function LinkPreviewCard({ message, preview, canRemove }: { message: ChatMessage; preview: ChatLinkPreview; canRemove: boolean }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await removeLinkPreviewAction(preview.id).catch(() => ({ error: REMOVE_FAILED }));
    setBusy(false);
    if ("ok" in result && result.ok) {
      echoChatEvent({
        type: "previews",
        conversationId: message.conversationId,
        messageId: message.id,
        parentId: message.parentId,
        previews: message.previews.filter((item) => item.id !== preview.id),
      });
      return;
    }
    setError("error" in result ? result.error : REMOVE_FAILED);
  }

  const title = preview.title ?? preview.description ?? preview.url;
  return (
    <div className="flex max-w-[520px] items-start gap-3 py-0.5 pl-3 shadow-[inset_3px_0_0_var(--color-surface-active)] max-md:max-w-full">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className={cn("flex items-center gap-1.5", canRemove && "pointer-coarse:min-h-11")}>
          <GlobeIcon aria-hidden className="text-subtle size-3 shrink-0" />
          <span className="caption-style text-subtle min-w-0 flex-1 truncate">{preview.site}</span>
          {canRemove && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove preview of ${title}`}
              disabled={busy}
              onClick={remove}
              className="hit text-faint hover:text-foreground shrink-0"
            >
              <RemoveIcon aria-hidden className="size-3" />
            </Button>
          )}
        </div>
        <a
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-violet focus-visible:ring-ring/60 line-clamp-2 rounded-[4px] text-[13.5px] leading-[19px] font-medium [overflow-wrap:anywhere] outline-none hover:underline focus-visible:ring-2"
        >
          {title}
        </a>
        {preview.title && preview.description && <p className="text-soft line-clamp-3 text-[13px] leading-[18px] [overflow-wrap:anywhere]">{preview.description}</p>}
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
      </div>
      {preview.image && !imageFailed && (
        <a href={preview.url} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden className="shrink-0">
          <Image
            src={`/api/chat/previews/${preview.id}/image`}
            alt=""
            width={84}
            height={84}
            unoptimized
            draggable={false}
            onError={() => setImageFailed(true)}
            className="bg-surface-raised size-[84px] rounded-lg object-cover max-md:size-16"
          />
        </a>
      )}
    </div>
  );
}

export default function MessageLinks({ message, viewerId, canRemove = true }: { message: ChatMessage; viewerId: string; canRemove?: boolean }) {
  const origin = useOrbitOrigin();
  if (message.deletedAt || message.hook) return null;
  const own = message.author.id === viewerId && !message.via;
  return (
    <>
      {origin && <RecordCards message={message} origin={origin} />}
      {message.previews.length > 0 && (
        <div className="mt-0.5 flex flex-col gap-2">
          {message.previews.map((preview) => (
            <LinkPreviewCard key={preview.id} message={message} preview={preview} canRemove={own && canRemove} />
          ))}
        </div>
      )}
    </>
  );
}
