export type SwipeDirection = "left" | "right";

export type SwipeHandlers = {
  canLeft?: boolean;
  canRight?: boolean;
  onDrag?: (dx: number) => void;
  onRelease?: (commit: SwipeDirection | null, velocity: number) => void;
  scroller?: () => HTMLElement | null;
};

const LOCK_RATIO = 0.75;
const VERTICAL_ESCAPE = 14;
const COMMIT_SHARE = 0.3;
const FLICK_DISTANCE = 32;
const FLICK_SPEED = 0.3;
const VELOCITY_WINDOW = 80;
const RESIST = 0.12;
const RESIST_CAP = 48;

type Sample = { x: number; y: number; at: number };
type Gesture = {
  id: number;
  x: number;
  y: number;
  lock: "x" | "y" | "scroll" | null;
  samples: Sample[];
  scrollTop: number;
};

export function velocityOf(samples: Sample[], axis: "x" | "y" = "x") {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  const inWindow = samples.find((sample) => last.at - sample.at <= VELOCITY_WINDOW);
  const first = inWindow && inWindow !== last ? inWindow : samples[samples.length - 2];
  const elapsed = last.at - first.at;
  return elapsed > 0 ? (last[axis] - first[axis]) / elapsed : 0;
}

export function swipeCommit(dx: number, speed: number, width: number, allowed: { left: boolean; right: boolean }): SwipeDirection | null {
  const direction: SwipeDirection = dx < 0 ? "left" : "right";
  if (!allowed[direction]) return null;
  const far = Math.abs(dx) > width * COMMIT_SHARE;
  const flick = Math.abs(dx) > FLICK_DISTANCE && Math.abs(speed) > FLICK_SPEED && Math.sign(speed) === Math.sign(dx);
  return far || flick ? direction : null;
}

export function resisted(dx: number, allowed: boolean) {
  if (allowed) return dx;
  return Math.sign(dx) * Math.min(RESIST_CAP, Math.abs(dx) * RESIST);
}

export function lockAxis(dx: number, dy: number): "x" | "y" | null {
  if (dx === 0 && dy === 0) return null;
  return Math.abs(dx) >= Math.abs(dy) * LOCK_RATIO ? "x" : "y";
}

function glide(element: HTMLElement, speed: number) {
  let velocity = speed * 16;
  const step = () => {
    if (Math.abs(velocity) < 0.5) return;
    element.scrollTop -= velocity;
    velocity *= 0.92;
    window.requestAnimationFrame(step);
  };
  window.requestAnimationFrame(step);
}

export function watchSwipe(target: Document | HTMLElement, handlers: () => SwipeHandlers) {
  let gesture: Gesture | null = null;

  function touchOf(event: TouchEvent, id?: number) {
    const list = [...Array.from(event.touches), ...Array.from(event.changedTouches)];
    return id === undefined ? list[0] : list.find((touch) => touch.identifier === id);
  }

  function release(commit: SwipeDirection | null, velocity: number) {
    handlers().onRelease?.(commit, velocity);
  }

  function down(event: TouchEvent) {
    if (event.touches.length !== 1) {
      if (gesture?.lock === "x") release(null, 0);
      gesture = null;
      return;
    }
    const touch = touchOf(event);
    if (!touch) return;
    gesture = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      lock: null,
      samples: [{ x: touch.clientX, y: touch.clientY, at: event.timeStamp }],
      scrollTop: handlers().scroller?.()?.scrollTop ?? 0,
    };
  }

  function move(event: TouchEvent) {
    if (!gesture) return;
    const touch = touchOf(event, gesture.id);
    if (!touch) return;
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    gesture.samples.push({ x: touch.clientX, y: touch.clientY, at: event.timeStamp });
    if (gesture.samples.length > 6) gesture.samples.shift();
    if (gesture.lock === null) {
      gesture.lock = lockAxis(dx, dy);
      if (gesture.lock === null) return;
    }
    if (gesture.lock === "y") return;
    if (event.cancelable) event.preventDefault();
    if (gesture.lock === "x" && Math.hypot(dx, dy) <= VERTICAL_ESCAPE * 2 && Math.abs(dy) > VERTICAL_ESCAPE && Math.abs(dy) > Math.abs(dx) * 1.5) {
      gesture.lock = "scroll";
      release(null, 0);
    }
    if (gesture.lock === "scroll") {
      const scroller = handlers().scroller?.();
      if (scroller) scroller.scrollTop = gesture.scrollTop - dy;
      return;
    }
    const current = handlers();
    current.onDrag?.(resisted(dx, Boolean(dx < 0 ? current.canLeft : current.canRight)));
  }

  function up(event: TouchEvent) {
    const from = gesture;
    if (!from) return;
    const touch = touchOf(event, from.id);
    if (!touch) return;
    gesture = null;
    const previous = from.samples[from.samples.length - 1];
    if (!previous || previous.x !== touch.clientX || previous.y !== touch.clientY) from.samples.push({ x: touch.clientX, y: touch.clientY, at: event.timeStamp });
    if (from.lock === "scroll") {
      const scroller = handlers().scroller?.();
      if (scroller) glide(scroller, velocityOf(from.samples, "y"));
      return;
    }
    if (from.lock !== "x") return;
    const dx = touch.clientX - from.x;
    const speed = velocityOf(from.samples);
    const current = handlers();
    release(swipeCommit(dx, speed, window.innerWidth, { left: Boolean(current.canLeft), right: Boolean(current.canRight) }), speed);
  }

  function cancel() {
    const from = gesture;
    gesture = null;
    if (from?.lock === "x") release(null, 0);
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
