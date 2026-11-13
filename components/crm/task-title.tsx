"use client";

import { useEffect, useId, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TaskRecordLink } from "@/components/crm/task-workspace";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { openDmAction } from "@/app/(crm)/chat/actions";
import { refreshChatSidebar } from "@/components/chat/chat-live";
import { chatLocationHref } from "@/lib/chat/routes";
import { taskTitleSegments, type TitleColleague, type TitleHere } from "@/lib/crm/task-title";
import type { Task } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import { useColleagueMessage } from "@/stores/colleague-message-store";

export const TITLE_LINK =
  "pointer-events-auto relative cursor-pointer rounded-sm underline decoration-white/30 decoration-1 underline-offset-[3px] hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--primary)";

const FAILED = "Couldn't open the conversation. Try again.";

function stop(event: MouseEvent) {
  event.stopPropagation();
}

function MessageAlert({ source }: { source: string }) {
  const error = useColleagueMessage((state) => (state.error?.source === source ? state.error.message : null));
  const dismiss = useColleagueMessage((state) => state.dismiss);
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(dismiss, 6000);
    return () => window.clearTimeout(timer);
  }, [error, dismiss]);
  if (!error || typeof document === "undefined") return null;
  return createPortal(
    <span
      role="alert"
      onClick={stop}
      onPointerDown={stop}
      className="bg-card border-line-strong text-danger caption-style pointer-events-auto fixed bottom-24 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border px-3 py-2 whitespace-normal shadow-lg"
    >
      {error}
      <Button variant="ghost" size="sm" onClick={dismiss} className="hit text-soft">
        Dismiss
      </Button>
    </span>,
    document.body,
  );
}

export function useMessageColleague() {
  const router = useRouter();
  const source = useId();
  const pending = useColleagueMessage((state) => state.pending === source);
  const start = useColleagueMessage((state) => state.start);
  const finish = useColleagueMessage((state) => state.finish);
  async function open(userId: string) {
    if (!start(source)) return;
    const result = await openDmAction(userId).catch(() => ({ error: FAILED }));
    if ("ok" in result && result.ok) {
      finish();
      refreshChatSidebar();
      router.push(chatLocationHref({ view: { kind: "room", id: result.conversation.id } }));
      return;
    }
    finish({ source, message: "error" in result && result.error ? result.error : FAILED });
  }
  return { open, pending, source };
}

export function ColleagueLink({
  colleague,
  children,
  className,
  label,
}: {
  colleague: TitleColleague;
  children?: ReactNode;
  className?: string;
  label?: string;
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
        aria-label={label ?? `Message ${colleague.name}`}
        title={label ?? `Message ${colleague.name}`}
        aria-busy={message.pending || undefined}
        disabled={message.pending}
        className={cn(TITLE_LINK, "decoration-dotted decoration-white/45 disabled:cursor-wait disabled:opacity-60", className)}
      >
        {children ?? colleague.name}
      </button>
      <MessageAlert source={message.source} />
    </>
  );
}

export default function TaskTitle({
  task,
  colleagues = [],
  viewerId = null,
  here = null,
}: {
  task: Pick<
    Task,
    "title" | "companyId" | "companyName" | "contactId" | "contactName" | "contactFirstName" | "contactLastName" | "opportunityId" | "opportunityName"
  >;
  colleagues?: TitleColleague[];
  viewerId?: string | null;
  here?: TitleHere | null;
}) {
  return taskTitleSegments(task, colleagues, viewerId, here).map((segment, index) => {
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
      <TaskRecordLink key={index} href={target.href} onClick={stop} onPointerDown={stop} title={target.name} className={TITLE_LINK}>
        {segment.text}
      </TaskRecordLink>
    );
  });
}
