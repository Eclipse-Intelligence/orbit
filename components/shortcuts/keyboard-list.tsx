"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { activeRow, useShortcut } from "@/components/shortcuts/shortcuts-provider";

const SEQUENCE_STORAGE = "orbit-list-sequence";
const ROW = "[data-list-row]";

function visibleRows(root: HTMLElement | null) {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(ROW)].filter((row) => row.getClientRects().length > 0);
}

function rowHref(row: HTMLElement) {
  return row.dataset.rowHref ?? row.querySelector<HTMLAnchorElement>("a[href^='/']")?.getAttribute("href") ?? null;
}

function setActive(row: HTMLElement | null) {
  const current = activeRow();
  if (current && current !== row) current.removeAttribute("data-kb-active");
  if (!row) return;
  row.setAttribute("data-kb-active", "true");
  if (!row.hasAttribute("tabindex")) row.tabIndex = -1;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
}

export function readListSequence() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SEQUENCE_STORAGE) ?? "null") as { hrefs?: unknown } | null;
    return Array.isArray(parsed?.hrefs) ? parsed.hrefs.filter((href): href is string => typeof href === "string") : [];
  } catch {
    return [];
  }
}

export default function KeyboardList({
  children,
  className,
  sequence = false,
}: {
  children: ReactNode;
  className?: string;
  sequence?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    function onFocus(event: FocusEvent) {
      const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(ROW);
      if (row && root?.contains(row) && row !== activeRow()) {
        activeRow()?.removeAttribute("data-kb-active");
        row.setAttribute("data-kb-active", "true");
      }
    }
    root.addEventListener("focusin", onFocus);
    return () => {
      root.removeEventListener("focusin", onFocus);
      activeRow()?.removeAttribute("data-kb-active");
    };
  }, []);

  useEffect(() => {
    if (!sequence) return;
    const hrefs = visibleRows(ref.current)
      .map(rowHref)
      .filter((href): href is string => Boolean(href));
    try {
      sessionStorage.setItem(SEQUENCE_STORAGE, JSON.stringify({ list: pathname, hrefs }));
    } catch {}
  });

  function move(delta: number, extend = false) {
    const rows = visibleRows(ref.current);
    if (rows.length === 0) return false;
    const current = rows.findIndex((row) => row.dataset.kbActive === "true");
    if (extend && current >= 0) {
      const here = rows[current].querySelector<HTMLInputElement>('[data-row-key="x"]');
      if (here && !here.checked && here.getAttribute("aria-checked") !== "true") here.click();
    }
    const next =
      current < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, current + delta));
    setActive(rows[next]);
    if (extend) {
      const box = rows[next].querySelector<HTMLInputElement>('[data-row-key="x"]');
      if (box && !box.checked && box.getAttribute("aria-checked") !== "true") box.click();
    }
    return true;
  }

  function hasActive() {
    const row = activeRow();
    return Boolean(row && ref.current?.contains(row));
  }

  useShortcut("list-down", () => move(1));
  useShortcut("list-up", () => move(-1));
  useShortcut("list-down-arrow", () => (hasActive() ? move(1) : false));
  useShortcut("list-up-arrow", () => (hasActive() ? move(-1) : false));
  useShortcut("list-extend-down", () => move(1, true));
  useShortcut("list-extend-up", () => move(-1, true));
  useShortcut("list-open", () => {
    const row = activeRow();
    if (!row || !ref.current?.contains(row)) return false;
    const focused = document.activeElement;
    if (focused && focused !== row && focused !== document.body) return false;
    const open = row.querySelector<HTMLElement>("[data-row-open]");
    if (open) {
      open.click();
      return;
    }
    const href = rowHref(row);
    if (href) {
      router.push(href);
      return;
    }
    row.click();
  });
  useShortcut("back", () => {
    const row = activeRow();
    if (!row || !ref.current?.contains(row)) return false;
    row.removeAttribute("data-kb-active");
    row.blur();
  });

  return (
    <div ref={ref} data-keyboard-list="" className={className}>
      {children}
    </div>
  );
}
