"use client";

import Button from "@/components/_ui/button";
import type { TaskClosedAfter, TaskDoneOffer } from "@/lib/crm/task-done";
import { closedAfterText, looksDoneOpenLabel, looksDoneWhat } from "@/lib/crm/task-done-text";
import type { Task } from "@/lib/crm/types";

export type LooksDoneHandlers = {
  close: (task: Task, offer: TaskDoneOffer, place: "row" | "panel") => void;
  dismiss: (task: Task, offer: TaskDoneOffer) => void;
};

type LooksDoneProps = {
  task: Task;
  offer: TaskDoneOffer;
  handlers?: LooksDoneHandlers;
  canChange: boolean;
};

export function LooksDoneLine({ task, offer, handlers, canChange }: LooksDoneProps) {
  return (
    <div role="group" aria-label="Looks done" className="bg-success/[0.08] flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-[10px] py-1.5 pr-1.5 pl-2.5 max-sm:flex-col max-sm:items-stretch">
      <span className="flex min-w-[12em] flex-1 items-baseline gap-1.5 text-[12.5px] leading-5 text-(--tag-green-text)">
        <span aria-hidden className="bg-success size-1.5 shrink-0 rounded-full" />
        <span>
          Looks done <span className="text-soft">· {looksDoneWhat(offer)}</span>
        </span>
      </span>
      {canChange && handlers && (
        <span className="flex gap-1.5 max-sm:[&>*]:flex-1 [@media(pointer:coarse)]:gap-3">
          <Button variant="primary" size="sm" onClick={() => handlers.close(task, offer, "row")} className="hit">
            Close
          </Button>
          <Button variant="ghost" size="sm" onClick={() => handlers.dismiss(task, offer)} className="hit">
            Not yet
          </Button>
        </span>
      )}
    </div>
  );
}

export function LooksDoneCard({ task, offer, handlers, canChange }: LooksDoneProps) {
  return (
    <section aria-label="Looks done" className="bg-success/[0.08] flex flex-col gap-2 rounded-xl p-3">
      <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-(--tag-green-text)">
        <span aria-hidden className="bg-success size-1.5 rounded-full" />
        Looks done
      </h3>
      <p className="text-soft text-[13px]">
        <span className="text-foreground font-medium">{looksDoneWhat(offer)}.</span>
        {offer.note ? ` ${offer.note}` : null}
      </p>
      <div className="flex flex-wrap gap-1.5 [@media(pointer:coarse)]:gap-3">
        {canChange && handlers && (
          <>
            <Button variant="primary" size="md" onClick={() => handlers.close(task, offer, "panel")} className="hit">
              Close
            </Button>
            <Button variant="ghost" size="md" onClick={() => handlers.dismiss(task, offer)} className="hit">
              Not yet
            </Button>
          </>
        )}
        {offer.href && (
          <Button variant="ghost" size="md" href={offer.href} className="hit">
            {looksDoneOpenLabel(offer.kind)}
          </Button>
        )}
      </div>
    </section>
  );
}

export function ClosedAfter({ reason, className }: { reason: TaskClosedAfter; className?: string }) {
  return <p className={className ?? "caption-style text-subtle"}>{closedAfterText(reason)}</p>;
}
