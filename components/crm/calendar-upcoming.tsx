"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import { useComposer } from "@/components/mail/compose-dock";
import { REPEAT_SAVE_FAILED, RepeatIcon, useUndoToast } from "@/components/crm/task-repeat";
import { moveUpcomingAction, skipUpcomingAction, undoRepeatAction, type RepeatActionResult, type UpcomingTarget } from "@/app/(crm)/repeats";
import { clockLabel, durationLabel } from "@/lib/crm/task-time";
import type { TaskBlock } from "@/lib/task-blocks";
import type { DropPlacement } from "@/lib/task-drag";
import { shortDay } from "@/lib/task-repeat";

const UNDO_FAILED = "Couldn't undo. Try again.";

export function upcomingWhen(block: TaskBlock) {
  const day = shortDay(block.task.dueDate ?? block.upcoming!.occursOn);
  return block.task.dueHasTime && block.task.dueAt ? `${day}, ${clockLabel(block.task.dueAt)}` : day;
}

function targetOf(block: TaskBlock): UpcomingTarget | null {
  const upcoming = block.upcoming;
  if (!upcoming?.currentTaskId) return null;
  return { currentTaskId: upcoming.currentTaskId, seriesId: upcoming.seriesId, occursOn: upcoming.occursOn };
}

export function useUpcomingMove() {
  const composer = useComposer();
  const router = useRouter();
  const undoToast = useUndoToast();
  const failed = useCallback((message?: string) => composer.showToast({ message: message || REPEAT_SAVE_FAILED, tone: "alert" }), [composer]);
  return useCallback(
    (block: TaskBlock, placement: DropPlacement, onFailed: () => void) => {
      const target = targetOf(block);
      if (!target || placement.dateOnly === true) {
        onFailed();
        return;
      }
      const move: { dueAt?: string; durationMinutes?: number } = {};
      if (Date.parse(placement.at) !== Date.parse(block.task.dueAt ?? "")) move.dueAt = placement.at;
      if (placement.durationMinutes !== block.task.durationMinutes) move.durationMinutes = placement.durationMinutes;
      if (!move.dueAt && !move.durationMinutes) {
        onFailed();
        return;
      }
      const day = shortDay(block.upcoming!.occursOn);
      const rescope = (scope: "following" | "all", undo: string[], message: string) =>
        void moveUpcomingAction(target, move, scope, undo)
          .catch((): RepeatActionResult => ({ error: REPEAT_SAVE_FAILED }))
          .then((result) => {
            if (result.error) failed(result.error);
            else undoToast(target.currentTaskId, message, result.undo);
            router.refresh();
          });
      void moveUpcomingAction(target, move, "this")
        .catch((): RepeatActionResult => ({ error: REPEAT_SAVE_FAILED }))
        .then((result) => {
          if (result.error) {
            onFailed();
            failed(result.error);
            return;
          }
          router.refresh();
          const undo = result.undo ?? [];
          composer.showToast({
            message: `Moved ${day} only.`,
            duration: 10_000,
            choices: [
              { label: "This and following", run: () => rescope("following", undo, `Moved ${day} and later.`) },
              { label: "All", run: () => rescope("all", undo, "Moved every one.") },
            ],
            ...(undo.length > 0
              ? {
                  action: {
                    label: "Undo",
                    run: () =>
                      void undoRepeatAction(target.currentTaskId, undo)
                        .catch(() => ({ error: UNDO_FAILED }))
                        .then((undone: { error?: string }) => {
                          if (undone.error) failed(undone.error);
                          router.refresh();
                        }),
                  },
                }
              : {}),
          });
        });
    },
    [composer, failed, router, undoToast],
  );
}

export default function UpcomingDialog({
  block,
  onClose,
  onOpenTask,
}: {
  block: TaskBlock | null;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const composer = useComposer();
  const router = useRouter();
  const undoToast = useUndoToast();
  const [busy, setBusy] = useState(false);
  const target = block ? targetOf(block) : null;
  const skip = async () => {
    if (!block || !target) return;
    setBusy(true);
    const result = await skipUpcomingAction(target).catch((): RepeatActionResult => ({ error: REPEAT_SAVE_FAILED }));
    setBusy(false);
    if (result.error) {
      composer.showToast({ message: result.error, tone: "alert" });
      return;
    }
    onClose();
    undoToast(target.currentTaskId, `Skipped ${shortDay(block.upcoming!.occursOn)}.`, result.undo);
    router.refresh();
  };
  return (
    <Dialog open={Boolean(block)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[380px]">
        <DialogHeader className="pr-12">
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <RepeatIcon aria-hidden className="text-violet size-3.5 shrink-0" />
            <span className="truncate">{block?.title}</span>
          </DialogTitle>
          <DialogDescription>
            {block ? ["Upcoming", upcomingWhen(block), block.task.dueHasTime ? durationLabel(block.durationMinutes) : null].filter(Boolean).join(" · ") : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" size="md" className="hit" disabled={busy || !target} onClick={() => void skip()}>
            Skip this one
          </Button>
          <Button
            variant="primary"
            size="md"
            className="hit"
            disabled={!target}
            onClick={() => {
              if (!target) return;
              onClose();
              onOpenTask(target.currentTaskId);
            }}
          >
            Open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
