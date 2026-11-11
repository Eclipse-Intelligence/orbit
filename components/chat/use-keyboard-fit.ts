"use client";

import { useEffect, type RefObject } from "react";

const PHONE = "(max-width: 767px)";

export function useKeyboardFit(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const viewport = window.visualViewport;
    const node = ref.current;
    if (!enabled || !viewport || !node) return;
    const phone = window.matchMedia(PHONE);
    const clear = () => {
      node.style.height = "";
      node.style.top = "";
      delete node.dataset.keyboard;
    };
    const fit = () => {
      if (!phone.matches) {
        clear();
        return;
      }
      node.style.height = `${viewport.height}px`;
      node.style.top = `${viewport.offsetTop}px`;
      if (window.innerHeight - viewport.height > 80) node.dataset.keyboard = "";
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
  }, [ref, enabled]);
}

export const PHONE_LAYER =
  "max-md:fixed max-md:inset-x-0 max-md:top-0 max-md:h-dvh max-md:bg-background max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)] max-md:data-[keyboard]:pb-0";
