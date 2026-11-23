"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { watchSwipe, type SwipeHandlers } from "@/components/mail/swipe";
import { frameDocument } from "@/lib/mail/frame-document";
import { acceptFrameMessage, forwardedKey, frameToken } from "@/lib/mail/frame-keys";
import Button from "@/components/_ui/button";
import { cn } from "@/lib/utils";

const ASK_AGAIN_MS = [80, 250, 600, 1200, 2000];
const GIVE_UP_MS = 3000;

type FrameMessage = { token: string } & (
  | { type: "height"; value: number }
  | { type: "quotes"; found: boolean }
  | { type: "zoom"; zoomed: boolean }
  | { type: "pan"; dy: number }
  | { type: "key"; key: string; code: string; shiftKey: boolean; repeat: boolean }
  | { type: "touch"; phase: "touchstart" | "touchmove" | "touchend" | "touchcancel"; touches: FrameTouch[]; changed: FrameTouch[] }
);

type FrameTouch = { identifier: number; clientX: number; clientY: number };

function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function touchEvent(message: Extract<FrameMessage, { type: "touch" }>) {
  const event = new Event(message.phase, { cancelable: false });
  Object.defineProperty(event, "touches", { value: message.touches });
  Object.defineProperty(event, "changedTouches", { value: message.changed });
  return event;
}

export default function EmailFrame({
  html,
  rich,
  title,
  swipe,
  hideQuotes = false,
}: {
  html: string;
  rich: boolean;
  title: string;
  swipe?: () => SwipeHandlers;
  hideQuotes?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [nonce] = useState(randomNonce);
  const [token] = useState(randomNonce);
  const [height, setHeight] = useState(rich ? 320 : 80);
  const [measured, setMeasured] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const [quoted, setQuoted] = useState(false);
  const [showQuotes, setShowQuotes] = useState(false);
  const heard = useRef(false);
  const source = useMemo(() => frameDocument(html, rich, hideQuotes, nonce, token), [html, rich, hideQuotes, nonce, token]);

  const ask = useCallback(() => {
    if (!heard.current) frame.current?.contentWindow?.postMessage({ type: "measure" }, "*");
  }, []);

  useEffect(() => {
    heard.current = false;
    ask();
    const timers = ASK_AGAIN_MS.map((delay) => window.setTimeout(ask, delay));
    const giveUp = window.setTimeout(() => {
      if (!heard.current) setGaveUp(true);
    }, GIVE_UP_MS);
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      window.clearTimeout(giveUp);
    };
  }, [source, ask]);

  useEffect(() => {
    const proxy = document.createElement("div");
    const unwatch = swipe ? watchSwipe(proxy, swipe) : null;
    const listen = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const message = acceptFrameMessage(event.data, frameToken(frame.current.getAttribute("srcdoc"))) as FrameMessage | null;
      if (!message) return;
      if (message.type === "height" && Number.isFinite(message.value)) {
        heard.current = true;
        setHeight(Math.max(24, Math.ceil(message.value)));
        setMeasured(true);
      }
      else if (message.type === "quotes") setQuoted(Boolean(message.found));
      else if (message.type === "zoom") {
        if (message.zoomed) proxy.dataset.orbitZoomed = "true";
        else delete proxy.dataset.orbitZoomed;
      } else if (message.type === "pan" && Number.isFinite(message.dy)) {
        const scroller = swipe?.().scroller?.();
        if (scroller) scroller.scrollTop -= message.dy;
      } else if (message.type === "touch" && Array.isArray(message.touches) && Array.isArray(message.changed)) {
        proxy.dispatchEvent(touchEvent(message));
      } else if (message.type === "key") {
        const forwarded = forwardedKey(message);
        if (forwarded) window.dispatchEvent(new KeyboardEvent("keydown", { ...forwarded, bubbles: true, cancelable: true }));
      }
    };
    window.addEventListener("message", listen);
    return () => {
      window.removeEventListener("message", listen);
      unwatch?.();
    };
  }, [swipe]);

  const toggleQuotes = () => {
    const next = !showQuotes;
    setShowQuotes(next);
    frame.current?.contentWindow?.postMessage({ type: "quotes", show: next }, "*");
  };

  return (
    <>
      <iframe
        ref={frame}
        title={title}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={source}
        suppressHydrationWarning
        onLoad={() => {
          heard.current = false;
          ask();
        }}
        aria-busy={!measured && !gaveUp}
        className={cn("block w-full border-0", rich && "rounded-xl bg-white")}
        style={{ height: measured || !gaveUp ? height : "min(70dvh, 40rem)" }}
      />
      {quoted && <QuoteToggle shown={showQuotes} onToggle={toggleQuotes} />}
    </>
  );
}

export function QuoteToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-expanded={shown}
      aria-label={shown ? "Hide quoted text" : "Show quoted text"}
      title={shown ? "Hide quoted text" : "Show quoted text"}
      onClick={onToggle}
      className="self-start px-2.5 tracking-[0.2em] pointer-coarse:h-11 pointer-coarse:px-4"
    >
      •••
    </Button>
  );
}
