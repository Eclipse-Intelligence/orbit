export type SwipeDirection = "left" | "right";

export type SwipeHandlers = {
  onLeft?: () => void;
  onRight?: () => void;
  onDrag?: (dx: number) => void;
  onSettle?: (commit: SwipeDirection | null) => void;
};

const LOCK_DISTANCE = 10;
const COMMIT_SHARE = 0.28;
const FLICK_DISTANCE = 40;
const FLICK_SPEED = 0.4;
const SETTLE_MS = 200;
const RESIST = 0.18;

type Sample = { x: number; at: number };
type Gesture = { x: number; y: number; lock: "x" | "y" | null; samples: Sample[] };

function velocity(samples: Sample[]) {
  const last = samples[samples.length - 1];
  const first = samples.find((sample) => last.at - sample.at <= 90) ?? samples[0];
  const elapsed = last.at - first.at;
  return elapsed > 0 ? (last.x - first.x) / elapsed : 0;
}

export function swipeCommit(dx: number, speed: number, width: number, allowed: { left: boolean; right: boolean }): SwipeDirection | null {
  const direction: SwipeDirection = dx < 0 ? "left" : "right";
  if (!allowed[direction]) return null;
  const far = Math.abs(dx) > width * COMMIT_SHARE;
  const flick = Math.abs(dx) > FLICK_DISTANCE && Math.abs(speed) > FLICK_SPEED && Math.sign(speed) === Math.sign(dx);
  return far || flick ? direction : null;
}

export function resisted(dx: number, allowed: boolean) {
  return allowed ? dx : dx * RESIST;
}

export function watchSwipe(target: Document | HTMLElement, handlers: () => SwipeHandlers) {
  let gesture: Gesture | null = null;
  const view = (target.ownerDocument ?? (target as Document)).defaultView ?? window;

  function point(event: TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch ? { x: touch.screenX, y: touch.screenY } : null;
  }

  function down(event: TouchEvent) {
    const at = point(event);
    if (event.touches.length !== 1 || !at) {
      gesture = null;
      return;
    }
    gesture = { x: at.x, y: at.y, lock: null, samples: [{ x: at.x, at: event.timeStamp }] };
  }

  function move(event: TouchEvent) {
    const at = point(event);
    if (!gesture || !at) return;
    const dx = at.x - gesture.x;
    const dy = at.y - gesture.y;
    if (!gesture.lock) {
      if (Math.hypot(dx, dy) < LOCK_DISTANCE) return;
      gesture.lock = Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
    }
    if (gesture.lock !== "x") return;
    if (event.cancelable) event.preventDefault();
    gesture.samples.push({ x: at.x, at: event.timeStamp });
    if (gesture.samples.length > 8) gesture.samples.shift();
    const current = handlers();
    current.onDrag?.(resisted(dx, Boolean(dx < 0 ? current.onLeft : current.onRight)));
  }

  function up(event: TouchEvent) {
    const from = gesture;
    gesture = null;
    const at = point(event);
    if (!from || from.lock !== "x" || !at) return;
    const dx = at.x - from.x;
    from.samples.push({ x: at.x, at: event.timeStamp });
    const current = handlers();
    const commit = swipeCommit(dx, velocity(from.samples), view.innerWidth, { left: Boolean(current.onLeft), right: Boolean(current.onRight) });
    current.onSettle?.(commit);
    if (!commit) return;
    const run = commit === "left" ? current.onLeft : current.onRight;
    if (current.onSettle) window.setTimeout(() => run?.(), SETTLE_MS);
    else run?.();
  }

  function cancel() {
    const from = gesture;
    gesture = null;
    if (from?.lock === "x") handlers().onSettle?.(null);
  }

  target.addEventListener("touchstart", down as EventListener, { passive: true });
  target.addEventListener("touchmove", move as EventListener, { passive: false });
  target.addEventListener("touchend", up as EventListener, { passive: true });
  target.addEventListener("touchcancel", cancel, { passive: true });
  return () => {
    target.removeEventListener("touchstart", down as EventListener);
    target.removeEventListener("touchmove", move as EventListener);
    target.removeEventListener("touchend", up as EventListener);
    target.removeEventListener("touchcancel", cancel);
  };
}
