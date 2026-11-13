export const LONG_PRESS_MS = 350;
const MOUSE_SLOP = 4;
const TOUCH_SLOP = 8;

export type GestureResult = "tap" | "drop" | "cancel";

type GestureStart = { pointerType: string; pointerId: number; clientX: number; clientY: number };

type GestureHandlers = {
  start: () => void;
  move: (clientX: number, clientY: number) => void;
  end: (result: GestureResult) => void;
};

type GestureOptions = { touchTarget?: EventTarget | null };

export function startPointerGesture(event: GestureStart, handlers: GestureHandlers, options: GestureOptions = {}) {
  const touch = event.pointerType === "touch";
  const touchTarget = touch ? (options.touchTarget ?? null) : null;
  let seen: Event | null = null;
  const startX = event.clientX;
  const startY = event.clientY;
  let x = startX;
  let y = startY;
  let active = false;
  let done = false;
  const timer = touch ? window.setTimeout(activate, LONG_PRESS_MS) : 0;

  function activate() {
    if (active || done) return;
    active = true;
    if (touch) navigator.vibrate?.(8);
    handlers.start();
    handlers.move(x, y);
  }

  function track(clientX: number, clientY: number) {
    x = clientX;
    y = clientY;
    if (active) {
      handlers.move(x, y);
      return;
    }
    const distance = Math.hypot(x - startX, y - startY);
    if (touch) {
      if (distance > TOUCH_SLOP) finish("cancel");
      return;
    }
    if (distance >= MOUSE_SLOP) activate();
  }

  function onPointerMove(move: PointerEvent) {
    if (move.pointerId === event.pointerId) track(move.clientX, move.clientY);
  }

  function onPointerUp(up: PointerEvent) {
    if (up.pointerId === event.pointerId) finish(active ? "drop" : "tap");
  }

  function onPointerCancel(cancel: PointerEvent) {
    if (cancel.pointerId !== event.pointerId) return;
    if (!touch || !active) finish("cancel");
  }

  function onTouchMove(move: TouchEvent) {
    if (move === seen) return;
    seen = move;
    const point = move.touches[0];
    if (active && move.cancelable) move.preventDefault();
    if (point) track(point.clientX, point.clientY);
  }

  function onTouchEnd(end: TouchEvent) {
    if (end === seen) return;
    seen = end;
    if (end.touches.length > 0) return;
    finish(active ? "drop" : "tap");
  }

  function onTouchCancel() {
    finish("cancel");
  }

  function blockMenu(menu: Event) {
    menu.preventDefault();
  }

  function finish(result: GestureResult) {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("touchend", onTouchEnd);
    window.removeEventListener("touchcancel", onTouchCancel);
    window.removeEventListener("contextmenu", blockMenu);
    touchTarget?.removeEventListener("touchmove", onTouchMove as EventListener);
    touchTarget?.removeEventListener("touchend", onTouchEnd as EventListener);
    touchTarget?.removeEventListener("touchcancel", onTouchCancel);
    handlers.end(result);
  }

  window.addEventListener("pointercancel", onPointerCancel);
  if (touch) {
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchCancel);
    window.addEventListener("contextmenu", blockMenu);
    touchTarget?.addEventListener("touchmove", onTouchMove as EventListener, { passive: false });
    touchTarget?.addEventListener("touchend", onTouchEnd as EventListener);
    touchTarget?.addEventListener("touchcancel", onTouchCancel);
    return;
  }
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}
