import { useEffect, type RefObject } from "react";

const TRIGGER = 64;
const MAX = 96;
const RESIST = 0.45;

export function usePullToRefresh(
  scroller: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  mark: RefObject<HTMLElement | null>,
  onRefresh: () => void,
) {
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let start: { x: number; y: number } | null = null;
    let pulling = false;
    let distance = 0;

    function paint(value: number, settle: boolean) {
      const body = content.current;
      const icon = mark.current;
      const transition = settle ? "transform 220ms var(--ease-power3-out), opacity 220ms var(--ease-power3-out)" : "none";
      if (body) {
        body.style.transition = transition;
        body.style.transform = value ? `translate3d(0, ${value}px, 0)` : "";
      }
      if (icon) {
        icon.style.transition = transition;
        icon.style.opacity = String(Math.min(1, value / TRIGGER));
        icon.style.transform = `translate3d(-50%, ${Math.max(0, value - 36)}px, 0) rotate(${(value / TRIGGER) * 270}deg)`;
        icon.dataset.ready = value >= TRIGGER ? "true" : "false";
      }
    }

    function down(event: TouchEvent) {
      if (event.touches.length !== 1 || element!.scrollTop > 0) {
        start = null;
        return;
      }
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      pulling = false;
      distance = 0;
    }

    function move(event: TouchEvent) {
      if (!start) return;
      const touch = event.touches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!pulling) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
          start = null;
          return;
        }
        if (dy < 8 || element!.scrollTop > 0) return;
        pulling = true;
      }
      if (event.cancelable) event.preventDefault();
      distance = Math.min(MAX, Math.max(0, dy * RESIST));
      paint(distance, false);
    }

    function up() {
      if (!start) return;
      start = null;
      if (!pulling) return;
      pulling = false;
      if (distance >= TRIGGER) {
        navigator.vibrate?.(8);
        onRefresh();
      }
      distance = 0;
      paint(0, true);
    }

    element.addEventListener("touchstart", down, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", up, { passive: true });
    element.addEventListener("touchcancel", up, { passive: true });
    return () => {
      element.removeEventListener("touchstart", down);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", up);
      element.removeEventListener("touchcancel", up);
    };
  }, [scroller, content, mark, onRefresh]);
}
