"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
const MAX_ZOOM = 4;

type FrameMessage =
  | { type: "height"; value: number }
  | { type: "quotes"; found: boolean }
  | { type: "zoom"; zoomed: boolean }
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
  const config = JSON.stringify({ hideQuotes, selectors: QUOTE_SELECTORS, hideClass: HIDE_QUOTES, wrapId: WRAP_ID, maxZoom: MAX_ZOOM });
  return `(function () {
  var cfg = ${config.replace(/</g, "\\u003c")};
  var layout = { available: 0, width: 0, height: 0 };
  var zoom = 1;
  var lastHeight = -1;
  function post(message) { parent.postMessage(message, "*"); }
  function height() {
    var value = Math.ceil(document.body.scrollHeight);
    if (value !== lastHeight) { lastHeight = value; post({ type: "height", value: value }); }
  }
  function wrap() { return document.getElementById(cfg.wrapId); }
  function apply() {
    var box = wrap();
    if (!box || layout.available <= 0) return;
    var scale = (layout.available / layout.width) * zoom;
    var zoomed = zoom > 1.001;
    if (Math.abs(scale - 1) < 0.001) {
      box.style.transform = ""; box.style.width = ""; box.style.marginRight = ""; box.style.marginBottom = "";
    } else {
      box.style.width = layout.width + "px";
      box.style.transform = "scale(" + scale + ")";
      box.style.marginRight = (layout.width * scale - layout.width) + "px";
      box.style.marginBottom = (layout.height * scale - layout.height) + "px";
    }
    document.documentElement.style.setProperty("overflow-x", zoomed ? "auto" : "hidden", "important");
    document.documentElement.style.setProperty("touch-action", zoomed ? "pan-x pan-y" : "pan-y");
    post({ type: "zoom", zoomed: zoomed });
    height();
  }
  function fit() {
    var box = wrap();
    if (!box) return;
    box.style.transform = ""; box.style.width = ""; box.style.marginRight = ""; box.style.marginBottom = "";
    var available = box.clientWidth;
    var width = Math.max(box.scrollWidth, available);
    box.style.width = width + "px";
    layout = { available: available, width: width, height: box.offsetHeight };
    box.style.width = "";
    apply();
  }
  function zoomTo(next, anchorX) {
    var scroller = document.scrollingElement || document.documentElement;
    var target = Math.min(cfg.maxZoom, Math.max(1, next));
    if (Math.abs(target - zoom) < 0.005 || layout.available <= 0) return;
    var share = (anchorX + scroller.scrollLeft) / (layout.available * zoom);
    zoom = target;
    apply();
    scroller.scrollLeft = Math.max(0, share * layout.available * zoom - anchorX);
  }
  function list(touches) {
    var out = [];
    for (var i = 0; i < touches.length; i++) out.push({ identifier: touches[i].identifier, clientX: touches[i].clientX, clientY: touches[i].clientY });
    return out;
  }
  function start() {
    var root = document.documentElement;
    if (cfg.hideQuotes) {
      root.classList.add(cfg.hideClass);
      var found = Boolean(document.querySelector(cfg.selectors.join(","))) && Boolean(document.body.innerText.trim());
      if (!found) root.classList.remove(cfg.hideClass);
      post({ type: "quotes", found: found });
    }
    var pinch = null;
    var swipe = null;
    function spread(touches) { return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY) || 1; }
    function forward(event) {
      if (zoom > 1.001 && event.type !== "touchend" && event.type !== "touchcancel") return;
      post({ type: "touch", phase: event.type, touches: list(event.touches), changed: list(event.changedTouches) });
    }
    document.addEventListener("touchstart", function (event) {
      if (event.touches.length === 2) { pinch = { spread: spread(event.touches), zoom: zoom }; swipe = null; }
      else if (event.touches.length === 1) swipe = { x: event.touches[0].clientX, y: event.touches[0].clientY, lock: null };
      forward(event);
    }, { passive: true });
    document.addEventListener("touchmove", function (event) {
      if (pinch && event.touches.length === 2) {
        if (event.cancelable) event.preventDefault();
        zoomTo(pinch.zoom * spread(event.touches) / pinch.spread, (event.touches[0].clientX + event.touches[1].clientX) / 2);
        return;
      }
      if (swipe && event.touches.length === 1 && zoom <= 1.001) {
        var dx = event.touches[0].clientX - swipe.x;
        var dy = event.touches[0].clientY - swipe.y;
        if (!swipe.lock && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) swipe.lock = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (swipe.lock === "x" && event.cancelable) event.preventDefault();
      }
      forward(event);
    }, { passive: false });
    function finish(event) {
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
      zoomTo(zoom * Math.exp(-event.deltaY / 200), event.clientX);
    }, { passive: false });
    document.addEventListener("dblclick", function () { if (zoom > 1) zoomTo(1, 0); });
    document.addEventListener("load", fit, true);
    window.addEventListener("resize", fit);
    window.addEventListener("message", function (event) {
      if (event.source !== parent || !event.data || event.data.type !== "quotes") return;
      root.classList.toggle(cfg.hideClass, !event.data.show);
      fit();
    });
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(height).observe(document.body);
    fit();
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
</style><script nonce="${nonce}">${frameScript(hideQuotes)}</script></head><body><div id="${WRAP_ID}">${html}</div></body></html>`;
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
  const [quoted, setQuoted] = useState(false);
  const [showQuotes, setShowQuotes] = useState(false);
  const source = useMemo(() => documentFor(html, rich, hideQuotes, nonce), [html, rich, hideQuotes, nonce]);

  useEffect(() => {
    const proxy = document.createElement("div");
    const unwatch = swipe ? watchSwipe(proxy, swipe) : null;
    const listen = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const message = event.data as FrameMessage | null;
      if (!message || typeof message !== "object") return;
      if (message.type === "height" && Number.isFinite(message.value)) setHeight(Math.max(24, Math.ceil(message.value)));
      else if (message.type === "quotes") setQuoted(Boolean(message.found));
      else if (message.type === "zoom") {
        if (message.zoomed) proxy.dataset.orbitZoomed = "true";
        else delete proxy.dataset.orbitZoomed;
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
        className={cn("block w-full border-0", rich && "rounded-xl bg-white")}
        style={{ height }}
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
      className="self-start px-2.5 tracking-[0.2em]"
    >
      •••
    </Button>
  );
}
