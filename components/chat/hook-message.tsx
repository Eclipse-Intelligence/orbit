import LinkedText from "@/components/_ui/linked-text";
import type { ChatHookCard } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import BracesIcon from "@/public/assets/images/_common/braces.svg";
import ExternalIcon from "@/public/assets/images/booking/external.svg";

const AVATAR_SIZES = { md: "size-6", lg: "size-7" } as const;
const ICON_SIZES = { md: "size-3", lg: "size-3.5" } as const;

export function HookAvatar({ size = "lg", className }: { size?: "md" | "lg"; className?: string }) {
  return (
    <span aria-hidden className={cn("bg-muted text-soft inline-flex shrink-0 items-center justify-center rounded-[30%] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]", AVATAR_SIZES[size], className)}>
      <BracesIcon className={ICON_SIZES[size]} />
    </span>
  );
}

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function HookCardBody({ card, body, className }: { card: ChatHookCard; body: string; className?: string }) {
  return (
    <div className={cn("border-line-subtle bg-surface-field mt-1 flex max-w-[34em] min-w-0 flex-col gap-1 rounded-xl border px-3 py-2.5", className)}>
      {card.title && <span className="text-[14px] leading-[20px] font-medium [overflow-wrap:anywhere]">{card.title}</span>}
      {card.block ? (
        <pre className="text-soft max-h-[24em] overflow-auto font-mono text-[12px] leading-[18px] whitespace-pre-wrap [overflow-wrap:anywhere]">{body}</pre>
      ) : (
        <p className="ui-style text-soft whitespace-pre-wrap [overflow-wrap:anywhere]">
          <LinkedText text={body} markdown={false} />
        </p>
      )}
      {card.url && (
        <a
          href={card.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          title={card.url}
          className="ui-style text-foreground hover:bg-surface-hover border-line-strong mt-1 inline-flex min-h-7 max-w-full items-center gap-1.5 self-start rounded-lg border px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 max-md:min-h-11"
        >
          <ExternalIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">Open {host(card.url)}</span>
        </a>
      )}
    </div>
  );
}
