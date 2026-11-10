"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { watchSwipe, type SwipeHandlers } from "@/components/mail/swipe";
import Button from "@/components/_ui/button";
import { cn } from "@/lib/utils";

const QUOTE_SELECTORS = [
  ".gmail_quote_container",
  ".gmail_quote",
  ".gmail_extra",
  ".yahoo_quoted",
  'blockquote[type="cite"]',
  "#appendonsend ~ *",
  '[id^="divRplyFwdMsg"]',
  '[id^="divRplyFwdMsg"] ~ *',
  "#mail-editor-reference-message-container",
  "br:has(+ .gmail_quote)",
  "br:has(+ .gmail_quote_container)",
];

const HIDE_QUOTES = "orbit-hide-quotes";
const WRAP_ID = "orbit-mail";
const PAN_ID = "orbit-pan";
const MAX_ZOOM = 4;
const ASK_AGAIN_MS = [80, 250, 600, 1200, 2000];
const GIVE_UP_MS = 3000;

type FrameMessage =
  | { type: "height"; value: number }
  | { type: "quotes"; found: boolean }
  | { type: "zoom"; zoomed: boolean }
  | { type: "pan"; dy: number }
  | { type: "touch"; phase: "touchstart" | "touchmove" | "touchend" | "touchcancel"; touches: FrameTouch[]; changed: FrameTouch[] };

type FrameTouch = { identifier: number; clientX: number; clientY: number };

function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function policy(nonce: string) {
  return `default-src 'none'; script-src 'nonce-${nonce}'; img-src https: http: data:; style-src 'unsafe-inline' https: http:; font-src https: http: data:; media-src https: data:`;
}

function frameScript(hideQuotes: boolean) {
  const config = JSON.stringify({ hideQuotes, selectors: QUOTE_SELECTORS, hideClass: HIDE_QUOTES, wrapId: WRAP_ID, panId: PAN_ID, maxZoom: MAX_ZOOM });
  return `(function () {
  var cfg = ${config.replace(/</g, "\\u003c")};
  var layout = { available: 0, width: 0, height: 0 };
  var zoom = 1;
  var panX = 0;
  var lastHeight = -1;
  var started = false;
  var quotesFound = null;
  var lastWidth = -1;
  function post(message) { parent.postMessage(message, "*"); }
  function height(force) {
    if (!document.body) return;
    var value = Math.ceil(document.body.scrollHeight);
    if (force || value !== lastHeight) { lastHeight = value; post({ type: "height", value: value }); }
  }
  function report() {
    if (!started) return;
    fit();
    height(true);
    if (quotesFound !== null) post({ type: "quotes", found: quotesFound });
  }
  window.addEventListener("message", function (event) {
    if (event.source !== parent || !event.data) return;
    if (event.data.type === "measure") report();
    else if (event.data.type === "quotes" && started) {
      document.documentElement.classList.toggle(cfg.hideClass, !event.data.show);
      fit();
    }
  });
  function wrap() { return document.getElementById(cfg.wrapId); }
  function maxPan() { return Math.max(0, layout.available * zoom - layout.available); }
  function place() {
    var holder = document.getElementById(cfg.panId);
    if (!holder) return;
    var ratio = window.devicePixelRatio || 1;
    panX = Math.min(maxPan(), Math.max(0, panX));
    var shift = Math.round(panX * ratio) / ratio;
    holder.style.transform = shift ? "translate3d(" + (-shift) + "px,0,0)" : "";
  }
  function apply() {
    var box = wrap();
    if (!box || layout.available <= 0) return;
    var scale = (layout.available / layout.width) * zoom;
    if (Math.abs(scale - 1) < 0.001) {
      box.style.zoom = ""; box.style.width = "";
    } else {
      box.style.width = layout.width + "px";
      box.style.zoom = String(scale);
    }
    place();
    post({ type: "zoom", zoomed: zoom > 1.001 });
    height(false);
  }
  function fit() {
    var box = wrap();
    if (!box) return;
    box.style.zoom = ""; box.style.width = "";
    var available = box.clientWidth;
    var width = Math.max(box.scrollWidth, available);
    layout = { available: available, width: width, height: 0 };
    apply();
  }
  function zoomTo(next, anchorX, anchorY) {
    var target = Math.min(cfg.maxZoom, Math.max(1, next));
    if (Math.abs(target - zoom) < 0.005 || layout.available <= 0) return;
    var share = (anchorX + panX) / (layout.available * zoom);
    var ratio = target / zoom;
    zoom = target;
    panX = target <= 1.001 ? 0 : share * layout.available * zoom - anchorX;
    apply();
    if (anchorY) post({ type: "pan", dy: -anchorY * (ratio - 1) });
  }
  function list(touches) {
    var out = [];
    for (var i = 0; i < touches.length; i++) out.push({ identifier: touches[i].identifier, clientX: touches[i].screenX, clientY: touches[i].screenY });
    return out;
  }
  function start() {
    var root = document.documentElement;
    if (cfg.hideQuotes) {
      root.classList.add(cfg.hideClass);
      var found = Boolean(document.querySelector(cfg.selectors.join(","))) && Boolean(document.body.innerText.trim());
      if (!found) root.classList.remove(cfg.hideClass);
      quotesFound = found;
    }
    var pinch = null;
    var swipe = null;
    var pan = null;
    var frameRequest = 0;
    var pendingZoom = null;
    function flush() {
      frameRequest = 0;
      if (pendingZoom) { var next = pendingZoom; pendingZoom = null; zoomTo(next.zoom, next.x, next.y); }
    }
    function schedule() { if (!frameRequest) frameRequest = requestAnimationFrame(flush); }
    function spread(touches) { return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY) || 1; }
    function forward(event) {
      if (zoom > 1.001 && event.type !== "touchend" && event.type !== "touchcancel") return;
      post({ type: "touch", phase: event.type, touches: list(event.touches), changed: list(event.changedTouches) });
    }
    document.addEventListener("touchstart", function (event) {
      if (event.touches.length === 2) { pinch = { spread: spread(event.touches), zoom: zoom }; swipe = null; pan = null; }
      else if (event.touches.length === 1) {
        swipe = { x: event.touches[0].screenX, y: event.touches[0].screenY, lock: null };
        pan = zoom > 1.001 ? { x: event.touches[0].screenX, y: event.touches[0].screenY, lock: null } : null;
      }
      forward(event);
    }, { passive: true });
    document.addEventListener("touchmove", function (event) {
      if (pinch && event.touches.length === 2) {
        if (event.cancelable) event.preventDefault();
        pendingZoom = { zoom: pinch.zoom * spread(event.touches) / pinch.spread, x: (event.touches[0].clientX + event.touches[1].clientX) / 2, y: (event.touches[0].clientY + event.touches[1].clientY) / 2 };
        schedule();
        return;
      }
      if (pan && event.touches.length === 1) {
        var touch = event.touches[0];
        var moveX = touch.screenX - pan.x;
        if (!pan.lock) pan.lock = Math.abs(moveX) > Math.abs(touch.screenY - pan.y) ? "x" : "y";
        if (pan.lock === "y") return;
        if (event.cancelable) event.preventDefault();
        panX -= moveX;
        place();
        pan.x = touch.screenX;
        pan.y = touch.screenY;
        return;
      }
      if (swipe && event.touches.length === 1 && zoom <= 1.001) {
        var dx = event.touches[0].screenX - swipe.x;
        var dy = event.touches[0].screenY - swipe.y;
        if (!swipe.lock && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) swipe.lock = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (swipe.lock === "x" && event.cancelable) event.preventDefault();
      }
      forward(event);
    }, { passive: false });
    function finish(event) {
      if (event.touches.length === 0) pan = null;
      if (event.touches.length < 2 && pinch) { pinch = null; if (zoom < 1.05 && zoom !== 1) zoomTo(1, 0); }
      if (event.touches.length === 0) swipe = null;
      forward(event);
    }
    document.addEventListener("touchend", finish, { passive: true });
    document.addEventListener("touchcancel", finish, { passive: true });
    document.addEventListener("gesturestart", function (event) { event.preventDefault(); });
    document.addEventListener("gesturechange", function (event) { event.preventDefault(); });
    document.addEventListener("wheel", function (event) {
      if (!event.ctrlKey) return;
      event.preventDefault();
      zoomTo(zoom * Math.exp(-event.deltaY / 200), event.clientX, event.clientY);
    }, { passive: false });
    document.addEventListener("dblclick", function () { if (zoom > 1) zoomTo(1, 0); });
    document.addEventListener("load", fit, true);
    window.addEventListener("load", report);
    if (typeof ResizeObserver === "undefined") window.addEventListener("resize", fit);
    else {
      new ResizeObserver(function () { height(false); }).observe(document.body);
      new ResizeObserver(function () {
        if (root.clientWidth === lastWidth) return;
        lastWidth = root.clientWidth;
        fit();
      }).observe(root);
    }
    started = true;
    report();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();`;
}

function documentFor(html: string, rich: boolean, hideQuotes: boolean, nonce: string) {
  const theme = rich
    ? "html,body{background:#fff;color:#111;}"
    : "html,body{background:transparent;color:#e6e8ec;} body *{color:inherit !important;background-color:transparent !important;border-color:#333 !important;} a,a *{color:#9db4ff !important;}";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy(nonce)}"><base target="_blank"><meta name="color-scheme" content="${rich ? "light" : "dark"}"><style>
html,body{margin:0;padding:0;touch-action:pan-y;}
html,body{overflow-x:hidden !important;}
#${WRAP_ID}{transform-origin:0 0;}
html:root,html:root body{height:auto !important;min-height:0 !important;max-height:none !important;overflow:visible !important;}
body{display:flow-root;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Geist,Helvetica,Arial,sans-serif;overflow-wrap:break-word;padding:${rich ? "20px" : "0"};}
img{max-width:100%;height:auto;}
pre{white-space:pre-wrap;}
blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:2px solid ${rich ? "#ddd" : "#3a3a3a"};}
${QUOTE_SELECTORS.map((selector) => `html.${HIDE_QUOTES} ${selector}`).join(",")}{display:none !important;}
${theme}
</style><script nonce="${nonce}">${frameScript(hideQuotes)}</script></head><body><div id="${PAN_ID}"><div id="${WRAP_ID}">${html}</div></div></body></html>`;
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
  const [height, setHeight] = useState(rich ? 320 : 80);
  const [measured, setMeasured] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const [quoted, setQuoted] = useState(false);
  const [showQuotes, setShowQuotes] = useState(false);
  const heard = useRef(false);
  const source = useMemo(() => documentFor(html, rich, hideQuotes, nonce), [html, rich, hideQuotes, nonce]);

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
      const message = event.data as FrameMessage | null;
      if (!message || typeof message !== "object") return;
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
