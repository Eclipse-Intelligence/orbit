"use client";

import { useEffect, type RefObject } from "react";

const PHONE = "(max-width: 767px)";

export function useKeyboardLift(ref: RefObject<HTMLElement | null>, selector = '[data-slot="dialog-content"]') {
  useEffect(() => {
    const viewport = window.visualViewport;
    const node = ref.current?.closest<HTMLElement>(selector);
    if (!viewport || !node) return;
    const phone = window.matchMedia(PHONE);
    const clear = () => {
      node.style.bottom = "";
      node.style.removeProperty("--sheet-max");
      delete node.dataset.keyboard;
    };
    const fit = () => {
      if (!phone.matches) {
        clear();
        return;
      }
      const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      node.style.bottom = `${covered}px`;
      node.style.setProperty("--sheet-max", `${Math.max(160, viewport.height - 8)}px`);
      if (covered > 80) node.dataset.keyboard = "";
      else delete node.dataset.keyboard;
    };
    fit();
    viewport.addEventListener("resize", fit);
    viewport.addEventListener("scroll", fit);
    phone.addEventListener("change", fit);
    return () => {
      viewport.removeEventListener("resize", fit);
      viewport.removeEventListener("scroll", fit);
      phone.removeEventListener("change", fit);
      clear();
    };
  }, [ref, selector]);
}
