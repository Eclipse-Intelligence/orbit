export type SwipeHandlers = { onLeft?: () => void; onRight?: () => void };

const DISTANCE = 70;
const MAX_MS = 700;

export function watchSwipe(target: Document | HTMLElement, handlers: () => SwipeHandlers) {
  let start: { x: number; y: number; at: number } | null = null;

  function down(event: TouchEvent) {
    if (event.touches.length !== 1) {
      start = null;
      return;
    }
    const touch = event.touches[0];
    start = { x: touch.clientX, y: touch.clientY, at: event.timeStamp };
  }

  function up(event: TouchEvent) {
    const from = start;
    start = null;
    const touch = event.changedTouches[0];
    if (!from || !touch || event.timeStamp - from.at > MAX_MS) return;
    const dx = touch.clientX - from.x;
    const dy = touch.clientY - from.y;
    if (Math.abs(dx) < DISTANCE || Math.abs(dy) > Math.abs(dx) * 0.5) return;
    const current = handlers();
    if (dx < 0) current.onLeft?.();
    else current.onRight?.();
  }

  function cancel() {
    start = null;
  }

  target.addEventListener("touchstart", down as EventListener, { passive: true });
  target.addEventListener("touchend", up as EventListener, { passive: true });
  target.addEventListener("touchcancel", cancel, { passive: true });
  return () => {
    target.removeEventListener("touchstart", down as EventListener);
    target.removeEventListener("touchend", up as EventListener);
    target.removeEventListener("touchcancel", cancel);
  };
}
