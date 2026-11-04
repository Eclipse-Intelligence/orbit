"use client";

import { useEffect } from "react";

function editing() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return true;
  return active instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(active.type);
}

export default function KeepPageInPlace() {
  useEffect(() => {
    let timer = 0;
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (editing()) return;
        if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
        pinShell();
      }, 120);
    };
    const viewport = window.visualViewport;
    const shell = document.querySelector<HTMLElement>("main[data-app-shell]");
    const pinShell = () => {
      if (!shell || editing()) return;
      if (shell.scrollTop !== 0 || shell.scrollLeft !== 0) shell.scrollTo(0, 0);
    };
    shell?.addEventListener("scroll", pinShell, { passive: true });
    window.addEventListener("scroll", settle, { passive: true });
    document.addEventListener("focusout", settle);
    viewport?.addEventListener("resize", settle);
    return () => {
      window.clearTimeout(timer);
      shell?.removeEventListener("scroll", pinShell);
      window.removeEventListener("scroll", settle);
      document.removeEventListener("focusout", settle);
      viewport?.removeEventListener("resize", settle);
    };
  }, []);
  return null;
}
