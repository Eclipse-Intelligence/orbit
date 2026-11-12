"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { openDmAction } from "@/app/(crm)/chat/actions";
import { refreshChatSidebar } from "@/components/chat/chat-live";
import { chatLocationHref } from "@/lib/chat/routes";
import { taskTitleSegments, type TitleColleague } from "@/lib/crm/task-title";
import type { Task } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

export const TITLE_LINK =
  "pointer-events-auto relative cursor-pointer rounded-sm underline decoration-white/30 decoration-1 underline-offset-[3px] hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--primary)";

function stop(event: MouseEvent) {
  event.stopPropagation();
}

export function useMessageColleague() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function open(userId: string) {
    if (busy) return;
    setBusy(userId);
    setError(null);
    const result = await openDmAction(userId).catch(() => ({ error: "Couldn't open the conversation. Try again." }));
    setBusy(null);
    if ("ok" in result && result.ok) {
      refreshChatSidebar();
      router.push(chatLocationHref({ view: { kind: "room", id: result.conversation.id } }));
      return;
    }
    setError("error" in result && result.error ? result.error : "Couldn't open the conversation. Try again.");
  }
  return { open, busy, error };
}

export function ColleagueLink({
  colleague,
  children,
  className,
}: {
  colleague: TitleColleague;
  children?: ReactNode;
  className?: string;
}) {
  const message = useMessageColleague();
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void message.open(colleague.id);
        }}
        onPointerDown={stop}
        aria-label={`Message ${colleague.name}`}
        title={`Message ${colleague.name}`}
        aria-busy={message.busy === colleague.id || undefined}
        className={cn(TITLE_LINK, "decoration-dotted decoration-white/45", className)}
      >
        {children ?? colleague.name}
      </button>
      {message.error && (
        <span role="alert" className="caption-style text-danger pointer-events-auto relative ml-1">
          {message.error}
        </span>
      )}
    </>
  );
}

export default function TaskTitle({
  task,
  colleagues = [],
  viewerId = null,
}: {
  task: Pick<
    Task,
    "title" | "companyId" | "companyName" | "contactId" | "contactName" | "contactFirstName" | "contactLastName" | "opportunityId" | "opportunityName"
  >;
  colleagues?: TitleColleague[];
  viewerId?: string | null;
}) {
  return taskTitleSegments(task, colleagues, viewerId).map((segment, index) => {
    const target = segment.target;
    if (!target) return <span key={index}>{segment.text}</span>;
    if (target.kind === "colleague") {
      return (
        <ColleagueLink key={index} colleague={{ id: target.id, name: target.name }}>
          {segment.text}
        </ColleagueLink>
      );
    }
    return (
      <Link key={index} href={target.href} onClick={stop} onPointerDown={stop} title={target.name} className={TITLE_LINK}>
        {segment.text}
      </Link>
    );
  });
}
