"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import { useComposer } from "@/components/mail/compose-dock";
import { RepeatIcon, useUndoToast } from "@/components/crm/task-repeat";
import { moveUpcomingAction, skipUpcomingAction, undoRepeatAction, type RepeatActionResult, type UpcomingTarget } from "@/app/(crm)/repeats";
import { dateKey } from "@/lib/calendar-view";
import { clockLabel, durationLabel } from "@/lib/crm/task-time";
import { dropRefusal, NOT_HERE, resetsFor, type TaskBlock } from "@/lib/task-blocks";
import type { DropPlacement } from "@/lib/task-drag";
import { shortDay } from "@/lib/task-repeat";
import { MOVE_FAILED, newActionKey, SKIP_FAILED } from "@/lib/task-repeat-menu";

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

export function useUpcomingMove(today: string) {
  const composer = useComposer();
  const router = useRouter();
  const undoToast = useUndoToast();
  const toasts = useRef(new Map<string, number>());
  const failed = useCallback(
    (message?: string, action?: { label: string; run: () => void }) => composer.showToast({ message: message || MOVE_FAILED, tone: "alert", ...(action ? { action } : {}) }),
    [composer],
  );
  return useCallback(
    (block: TaskBlock, placement: DropPlacement, onDone: (saved: boolean) => void) => {
      const target = targetOf(block);
      if (placement.dateOnly === true) {
        onDone(false);
        return;
      }
      const refusal = dropRefusal(block, placement.at, today);
      if (refusal || !target) {
        onDone(false);
        failed(refusal ?? NOT_HERE);
        return;
      }
      const move: { dueAt?: string; durationMinutes?: number } = {};
      if (Date.parse(placement.at) !== Date.parse(block.task.dueAt ?? "")) move.dueAt = placement.at;
      if (placement.durationMinutes !== block.task.durationMinutes) move.durationMinutes = placement.durationMinutes;
      if (!move.dueAt && !move.durationMinutes) {
        onDone(false);
        return;
      }
      const landed = dateKey(placement.at);
      const day = shortDay(landed);
      const sameDay = landed === block.upcoming!.occursOn;
      const verb = move.dueAt ? "Moved" : "Changed";
      const keys = { this: newActionKey(), following: newActionKey(), all: newActionKey() };
      const undoMove = (undo: string[]) =>
        undo.length > 0
          ? {
              label: "Undo",
              run: () =>
                void undoRepeatAction(target.currentTaskId, undo)
                  .catch(() => ({ error: UNDO_FAILED }))
                  .then((undone: { error?: string }) => {
                    if (undone.error) failed(undone.error);
                    router.refresh();
                  }),
            }
          : undefined;
      const rescope = (scope: "following" | "all", undo: string[], message: string) =>
        void moveUpcomingAction(target, move, scope, undo, keys[scope])
          .catch((): RepeatActionResult => ({ error: MOVE_FAILED }))
          .then((result) => {
            if (result.error) failed(result.error, undoMove(undo));
            else undoToast(target.currentTaskId, message, result.undo);
            router.refresh();
          });
      void moveUpcomingAction(target, move, "this", [], keys.this)
        .catch((): RepeatActionResult => ({ error: MOVE_FAILED }))
        .then((result) => {
          if (result.error) {
            onDone(false);
            failed(result.error);
            return;
          }
          onDone(true);
          router.refresh();
          const undo = result.undo ?? [];
          const resets = move.dueAt ? resetsFor(block) : 0;
          const key = `${target.seriesId}|${target.occursOn}`;
          const earlier = toasts.current.get(key);
          if (earlier !== undefined) composer.dismissToast(earlier);
          const action = undoMove(undo);
          const confirmAll = () =>
            toasts.current.set(
              key,
              composer.showToast({
                message: `Resets ${resets} changed date${resets === 1 ? "" : "s"}.`,
                duration: 10_000,
                choices: [{ label: "Move all", run: () => rescope("all", undo, "Moved every one.") }],
                ...(action ? { action } : {}),
              }),
            );
          const id = composer.showToast({
            message: `${verb} ${day} only.`,
            duration: 10_000,
            ...(sameDay
              ? {
                  choices: [
                    { label: "This and following", run: () => rescope("following", undo, `${verb} ${day} and later.`) },
                    { label: "All", run: () => (resets > 0 ? confirmAll() : rescope("all", undo, `${verb} every one.`)) },
                  ],
                }
              : {}),
            ...(action ? { action } : {}),
          });
          toasts.current.set(key, id);
        });
    },
    [composer, failed, router, today, undoToast],
  );
}

export default function UpcomingDialog({
  block,
  onClose,
  onOpenTask,
  canOpen,
}: {
  block: TaskBlock | null;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
  canOpen: (taskId: string) => boolean;
}) {
  const composer = useComposer();
  const router = useRouter();
  const undoToast = useUndoToast();
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(block);
  const [skipKey, setSkipKey] = useState(newActionKey);
  if (block && block !== shown) {
    setShown(block);
    setSkipKey(newActionKey());
  }
  const target = shown ? targetOf(shown) : null;
  const openable = Boolean(target && canOpen(target.currentTaskId));
  const skip = async () => {
    if (!shown || !target) return;
    setBusy(true);
    const result = await skipUpcomingAction(target, skipKey).catch((): RepeatActionResult => ({ error: SKIP_FAILED }));
    setBusy(false);
    if (result.error) {
      composer.showToast({ message: result.error, tone: "alert" });
      return;
    }
    onClose();
    undoToast(target.currentTaskId, `Skipped ${shortDay(shown.task.dueDate ?? shown.upcoming!.occursOn)}.`, result.undo);
    router.refresh();
  };
  return (
    <Dialog open={Boolean(block)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[380px]">
        <DialogHeader className="pr-12">
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <RepeatIcon aria-hidden className="text-violet size-3.5 shrink-0" />
            <span className="truncate">{shown?.title}</span>
          </DialogTitle>
          <DialogDescription>
            {shown ? ["Upcoming", upcomingWhen(shown), shown.task.dueHasTime ? durationLabel(shown.durationMinutes) : null].filter(Boolean).join(" · ") : null}
          </DialogDescription>
        </DialogHeader>
        {!target && (
          <p role="status" className="caption-style text-subtle px-6">
            {NOT_HERE}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="md" className="hit mr-auto">
              Cancel
            </Button>
          </DialogClose>
          <Button variant="secondary" size="md" className="hit" disabled={busy || !target} onClick={() => void skip()}>
            Skip this one
          </Button>
          <Button
            variant="primary"
            size="md"
            className="hit"
            disabled={!openable}
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
