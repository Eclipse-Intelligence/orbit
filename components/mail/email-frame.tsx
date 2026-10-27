"use client";

import { useEffect, useRef, useState } from "react";
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
const EARLY_MS = 10_000;

const POLICY =
  "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https: http:; font-src https: http: data:; media-src https: data:";

function documentFor(html: string, rich: boolean) {
  const theme = rich
    ? "html,body{background:#fff;color:#111;}"
    : "html,body{background:transparent;color:#e6e8ec;} body *{color:inherit !important;background-color:transparent !important;border-color:#333 !important;} a,a *{color:#9db4ff !important;}";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}"><base target="_blank"><meta name="color-scheme" content="${rich ? "light" : "dark"}"><style>
html,body{margin:0;padding:0;touch-action:pan-y;}
html:root,html:root body{height:auto !important;min-height:0 !important;max-height:none !important;overflow:visible !important;}
body{display:flow-root;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Geist,Helvetica,Arial,sans-serif;overflow-wrap:anywhere;padding:${rich ? "20px" : "0"};}
img{max-width:100%;height:auto;}
table{max-width:100%;}
pre{white-space:pre-wrap;}
blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:2px solid ${rich ? "#ddd" : "#3a3a3a"};}
${QUOTE_SELECTORS.map((selector) => `html.${HIDE_QUOTES} ${selector}`).join(",")}{display:none !important;}
${theme}
</style></head><body>${html}</body></html>`;
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
  const shownHtml = useRef<string | null>(null);
  const [height, setHeight] = useState(rich ? 320 : 80);
  const [quoted, setQuoted] = useState(false);
  const [showQuotes, setShowQuotes] = useState(false);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let observer: ResizeObserver | null = null;
    let unwatch: (() => void) | null = null;
    let attached: Document | null = null;
    let poll = 0;
    const stale = shownHtml.current !== html ? element.contentDocument : null;
    const giveUp = Date.now() + EARLY_MS;
    shownHtml.current = html;
    const measure = () => {
      const body = element.contentDocument?.body;
      if (!body) return;
      setHeight(Math.max(24, Math.ceil(body.scrollHeight)));
    };
    const attach = () => {
      const doc = element.contentDocument;
      if (!doc?.body || doc.URL !== "about:srcdoc" || doc === stale) return;
      if (attached === doc) {
        measure();
        return;
      }
      attached = doc;
      if (hideQuotes && doc?.body) {
        doc.documentElement.classList.add(HIDE_QUOTES);
        const found = Boolean(doc.querySelector(QUOTE_SELECTORS.join(","))) && Boolean(doc.body.innerText.trim());
        if (!found) doc.documentElement.classList.remove(HIDE_QUOTES);
        setQuoted(found);
      }
      measure();
      unwatch?.();
      unwatch = swipe && element.contentDocument ? watchSwipe(element.contentDocument, swipe) : null;
      const body = element.contentDocument?.body;
      if (body && typeof ResizeObserver !== "undefined") {
        observer?.disconnect();
        observer = new ResizeObserver(measure);
        observer.observe(body);
      }
    };
    const early = () => {
      const doc = element.contentDocument;
      if (doc && doc !== stale && doc.URL === "about:srcdoc" && doc.readyState !== "loading" && doc.body) {
        attach();
        return;
      }
      if (Date.now() < giveUp) poll = window.requestAnimationFrame(early);
    };
    element.addEventListener("load", attach);
    early();
    return () => {
      window.cancelAnimationFrame(poll);
      element.removeEventListener("load", attach);
      observer?.disconnect();
      unwatch?.();
    };
  }, [html, swipe, hideQuotes]);

  const toggleQuotes = () => {
    const next = !showQuotes;
    setShowQuotes(next);
    frame.current?.contentDocument?.documentElement.classList.toggle(HIDE_QUOTES, !next);
  };

  return (
    <>
      <iframe
        ref={frame}
        title={title}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={documentFor(html, rich)}
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
