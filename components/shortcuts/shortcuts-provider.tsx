"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { isTypingTarget } from "@/lib/crm/quick-add";
import { setSidebarCollapsed } from "@/lib/sidebar";
import {
  SEQUENCE_TIMEOUT_MS,
  SHORTCUT_BY_ID,
  isSequencePrefix,
  isSingleKey,
  matchingShortcuts,
  sequenceShortcut,
  shortcutHint,
  type ShortcutDef,
} from "@/lib/shortcuts";

const SINGLE_KEYS_STORAGE = "orbit-single-key-shortcuts";
const REPEATABLE = new Set(["j", "k", "J", "K", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"]);

type Handler = () => boolean | void;

export type ListSearchConfig = {
  noun: string;
  value: string;
  hrefFor: (query: string) => string;
};

export type PaletteMode = "global" | "list";

type ShortcutsContextValue = {
  mac: boolean;
  singleKeys: boolean;
  setSingleKeys: (value: boolean) => void;
  paletteOpen: boolean;
  paletteMode: PaletteMode;
  openPalette: (mode?: PaletteMode) => void;
  setPaletteOpen: (open: boolean) => void;
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  listSearch: ListSearchConfig | null;
  setListSearch: (config: ListSearchConfig | null) => void;
  register: (id: string, handler: Handler) => () => void;
  run: (id: string) => boolean;
  available: (id: string) => boolean;
  hint: (id: string) => string;
};

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

export function useShortcuts() {
  const value = useContext(ShortcutsContext);
  if (!value) throw new Error("useShortcuts needs a ShortcutsProvider");
  return value;
}

export function useShortcut(id: string, handler: Handler, enabled = true) {
  const context = useContext(ShortcutsContext);
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  const register = context?.register;
  useEffect(() => {
    if (!enabled || !register) return;
    return register(id, () => latest.current());
  }, [id, enabled, register]);
}

export function useShortcutHint(id: string) {
  const context = useContext(ShortcutsContext);
  return context?.hint(id) ?? "";
}

export function overlayOpen() {
  if (document.querySelector("[data-radix-popper-content-wrapper]")) return true;
  return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(
    (node) => node.getAttribute("data-state") === "open",
  );
}

function usable(element: Element) {
  if (element.getClientRects().length === 0) return false;
  if (element instanceof HTMLButtonElement && element.disabled) return false;
  return element.getAttribute("aria-disabled") !== "true";
}

export function shortcutTarget(name: string) {
  return (
    [...document.querySelectorAll<HTMLElement>(`[data-shortcut="${name}"]`)].find(usable) ?? null
  );
}

export function activate(element: HTMLElement) {
  const popup = element.getAttribute("aria-haspopup");
  if (popup === "menu" || popup === "listbox" || element.getAttribute("role") === "combobox") {
    element.focus();
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return;
  }
  element.click();
}

export function activeRow() {
  return document.querySelector<HTMLElement>('[data-kb-active="true"]');
}

function rowKeyTarget(key: string) {
  const row = activeRow();
  if (!row) return null;
  const focused = document.activeElement;
  if (key === "space" && focused && focused !== row && focused !== document.body) return null;
  const element = row.querySelector<HTMLElement>(`[data-row-key="${key}"]`);
  return element && usable(element) ? element : null;
}

function submitFrom(element: Element | null) {
  const scope = element?.closest("[data-shortcut-scope]");
  const button = scope?.querySelector<HTMLElement>("[data-shortcut-submit]");
  if (button && usable(button)) {
    button.click();
    return true;
  }
  const form = element?.closest("form");
  if (!form) return false;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])');
  if (submit?.disabled) return true;
  form.requestSubmit();
  return true;
}

function detectMac() {
  if (typeof navigator === "undefined") return true;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [mac, setMac] = useState(true);
  const [singleKeys, setSingleKeysState] = useState(true);
  const [paletteOpen, setPaletteOpenState] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("global");
  const [helpOpen, setHelpOpen] = useState(false);
  const [listSearch, setListSearch] = useState<ListSearchConfig | null>(null);
  const handlers = useRef(new Map<string, Handler[]>());
  const fallbacks = useRef(new WeakSet<Handler>());
  const state = useRef({ singleKeys: true, mac: true, overlayAtDown: false });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const isMac = detectMac();
      let keys = true;
      try {
        keys = localStorage.getItem(SINGLE_KEYS_STORAGE) !== "off";
      } catch {}
      state.current.mac = isMac;
      state.current.singleKeys = keys;
      setMac(isMac);
      setSingleKeysState(keys);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const setSingleKeys = useCallback((value: boolean) => {
    state.current.singleKeys = value;
    setSingleKeysState(value);
    try {
      localStorage.setItem(SINGLE_KEYS_STORAGE, value ? "on" : "off");
    } catch {}
  }, []);

  const openPalette = useCallback((mode: PaletteMode = "global") => {
    setPaletteMode(mode);
    setPaletteOpenState(true);
  }, []);

  const setPaletteOpen = useCallback((open: boolean) => {
    if (open) setPaletteMode("global");
    setPaletteOpenState(open);
  }, []);

  const register = useCallback((id: string, handler: Handler) => {
    const stack = handlers.current.get(id) ?? [];
    stack.push(handler);
    handlers.current.set(id, stack);
    return () => {
      const current = handlers.current.get(id) ?? [];
      handlers.current.set(
        id,
        current.filter((entry) => entry !== handler),
      );
    };
  }, []);

  const runDef = useCallback(
    (def: ShortcutDef) => {
      if (def.rowKey) {
        const element = rowKeyTarget(def.rowKey);
        if (element) {
          activate(element);
          return true;
        }
      }
      const stack = handlers.current.get(def.id) ?? [];
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index]() !== false) return true;
      }
      if (def.target) {
        const element = shortcutTarget(def.target);
        if (element) {
          if (def.focus) element.focus();
          else activate(element);
          return true;
        }
      }
      if (def.href) {
        router.push(def.href);
        return true;
      }
      return false;
    },
    [router],
  );

  const run = useCallback(
    (id: string) => {
      const def = SHORTCUT_BY_ID.get(id);
      return def ? runDef(def) : false;
    },
    [runDef],
  );

  const available = useCallback((id: string) => {
    const def = SHORTCUT_BY_ID.get(id);
    if (!def) return false;
    if ((handlers.current.get(id) ?? []).some((handler) => !fallbacks.current.has(handler))) return true;
    if (def.rowKey && document.querySelector(`[data-row-key="${def.rowKey}"]`)) return true;
    if (def.target && shortcutTarget(def.target)) return true;
    return Boolean(def.href);
  }, []);

  const hint = useCallback((id: string) => shortcutHint(id, mac), [mac]);

  useEffect(() => {
    const fallback = (id: string, handler: Handler) => {
      fallbacks.current.add(handler);
      return register(id, handler);
    };
    const cleanups = [
      fallback("palette", () => {
        setPaletteMode("global");
        setPaletteOpenState((open) => !open);
      }),
      fallback("search-list", () => openPalette("global")),
      fallback("help", () => {
        const panel = window.matchMedia("(min-width: 64rem)").matches ? shortcutTarget("shortcuts-panel") : null;
        if (panel) panel.click();
        else setHelpOpen(true);
      }),
      fallback("sidebar", () => {
        if (!window.matchMedia("(min-width: 64rem)").matches) return false;
        setSidebarCollapsed(!("sidebarCollapsed" in document.documentElement.dataset));
      }),
      fallback("submit", () => submitFrom(document.activeElement)),
      fallback("save", () => {
        if (submitFrom(document.activeElement)) return;
        const button = shortcutTarget("save");
        if (button && overlayOpen() && !button.closest('[role="dialog"]')) return;
        if (button) button.click();
      }),
      fallback("create-event", () => {
        const button = shortcutTarget("new-event") ?? shortcutTarget("invite");
        if (button) {
          button.click();
          return;
        }
        router.push("/calendar?new=1");
      }),
      fallback("create-activity", () => router.push("/activities?add=1")),
      fallback("record-edit", () => {
        const button = shortcutTarget("edit");
        if (!button) return false;
        button.click();
        window.setTimeout(() => {
          const save = shortcutTarget("save");
          const form = save instanceof HTMLButtonElement ? save.form : save?.closest("form");
          const field = [...(form?.querySelectorAll<HTMLElement>("input:not([type=hidden]), textarea, select") ?? [])].find(
            (element) => element.getClientRects().length > 0,
          );
          field?.focus();
        }, 60);
      }),
      fallback("back", () => {
        const cancel = shortcutTarget("cancel-edit");
        if (!cancel) return false;
        cancel.click();
      }),
    ];
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [register, openPalette, router]);

  useEffect(() => {
    let pending: string | null = null;
    let timer = 0;

    function clearPending() {
      pending = null;
      window.clearTimeout(timer);
    }

    function onCapture() {
      state.current.overlayAtDown = overlayOpen();
    }

    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || (event.repeat && !REPEATABLE.has(event.key))) {
        clearPending();
        return;
      }
      const typing = isTypingTarget(event.target);
      const overlay = state.current.overlayAtDown;
      const { mac: isMac, singleKeys: keys } = state.current;

      if (pending) {
        const prefix = pending;
        clearPending();
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const def = sequenceShortcut(prefix, event.key);
        if (def && runDef(def)) event.preventDefault();
        return;
      }

      if (event.key === "Escape" && typing && !overlay && event.target instanceof HTMLElement) {
        event.target.blur();
        return;
      }

      const prefix = isSequencePrefix(event);
      if (prefix && !typing && !overlay && keys) {
        pending = prefix;
        timer = window.setTimeout(clearPending, SEQUENCE_TIMEOUT_MS);
        event.preventDefault();
        return;
      }

      for (const def of matchingShortcuts(event, isMac)) {
        if (typing && !def.whileTyping) continue;
        if (overlay && !def.inOverlay) continue;
        if (!keys && isSingleKey(def)) continue;
        if (runDef(def)) {
          event.preventDefault();
          return;
        }
      }
    }

    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onKey);
    return () => {
      clearPending();
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [runDef]);

  const value = useMemo<ShortcutsContextValue>(
    () => ({
      mac,
      singleKeys,
      setSingleKeys,
      paletteOpen,
      paletteMode,
      openPalette,
      setPaletteOpen,
      helpOpen,
      setHelpOpen,
      listSearch,
      setListSearch,
      register,
      run,
      available,
      hint,
    }),
    [mac, singleKeys, setSingleKeys, paletteOpen, paletteMode, openPalette, setPaletteOpen, helpOpen, listSearch, register, run, available, hint],
  );

  return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>;
}
