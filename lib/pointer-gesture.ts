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

const RELEASE_WAIT_MS = 10_000;

function afterEscapeCancel(pointerId: number) {
  const swallow = (click: Event) => {
    click.stopPropagation();
    click.preventDefault();
  };
  const held = (key: KeyboardEvent) => {
    if (key.key !== "Escape") return;
    key.preventDefault();
    key.stopImmediatePropagation();
  };
  const keysTimer = window.setTimeout(releaseKeys, RELEASE_WAIT_MS);
  function releaseKeys() {
    window.clearTimeout(keysTimer);
    window.removeEventListener("keydown", held, { capture: true });
    window.removeEventListener("keyup", lifted, { capture: true });
  }
  function lifted(key: KeyboardEvent) {
    if (key.key === "Escape") releaseKeys();
  }
  let timer = window.setTimeout(stop, RELEASE_WAIT_MS);
  function stop() {
    window.clearTimeout(timer);
    window.removeEventListener("pointerup", released, { capture: true });
    window.removeEventListener("pointercancel", cancelled, { capture: true });
    window.removeEventListener("pointerdown", stop, { capture: true });
    window.removeEventListener("click", swallow, { capture: true });
  }
  function released(up: Event) {
    if ((up as PointerEvent).pointerId !== pointerId) return;
    window.removeEventListener("pointerup", released, { capture: true });
    window.clearTimeout(timer);
    timer = window.setTimeout(stop, 0);
  }
  function cancelled(cancel: Event) {
    if ((cancel as PointerEvent).pointerId === pointerId) stop();
  }
  window.addEventListener("pointerup", released, { capture: true });
  window.addEventListener("pointercancel", cancelled, { capture: true });
  window.addEventListener("pointerdown", stop, { capture: true });
  window.addEventListener("click", swallow, { capture: true });
  window.addEventListener("keydown", held, { capture: true });
  window.addEventListener("keyup", lifted, { capture: true });
}

export function startPointerGesture(event: GestureStart, handlers: GestureHandlers, options: GestureOptions = {}): () => void {
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
    if (move.pointerId !== event.pointerId) return;
    if (move.buttons === 0) {
      finish("cancel");
      return;
    }
    track(move.clientX, move.clientY);
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

  function onMenu() {
    finish("cancel");
  }

  function onKeyDown(key: KeyboardEvent) {
    if (key.key !== "Escape" || !active) return;
    key.preventDefault();
    key.stopImmediatePropagation();
    finish("cancel");
    afterEscapeCancel(event.pointerId);
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
    window.removeEventListener("contextmenu", onMenu);
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    touchTarget?.removeEventListener("touchmove", onTouchMove as EventListener);
    touchTarget?.removeEventListener("touchend", onTouchEnd as EventListener);
    touchTarget?.removeEventListener("touchcancel", onTouchCancel);
    handlers.end(result);
  }

  window.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("keydown", onKeyDown, { capture: true });
  if (touch) {
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchCancel);
    window.addEventListener("contextmenu", blockMenu);
    touchTarget?.addEventListener("touchmove", onTouchMove as EventListener, { passive: false });
    touchTarget?.addEventListener("touchend", onTouchEnd as EventListener);
    touchTarget?.addEventListener("touchcancel", onTouchCancel);
  } else {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("contextmenu", onMenu);
  }
  return () => finish("cancel");
}
