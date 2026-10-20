"use client";

import { useEffect, useRef, useState } from "react";
import { watchSwipe, type SwipeHandlers } from "@/components/mail/swipe";
import { cn } from "@/lib/utils";

const POLICY =
  "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https: http:; font-src https: http: data:; media-src https: data:";

function documentFor(html: string, rich: boolean) {
  const theme = rich
    ? "html,body{background:#fff;color:#111;}"
    : "html,body{background:transparent;color:#e6e8ec;} body *{color:inherit !important;background-color:transparent !important;border-color:#333 !important;} a,a *{color:#9db4ff !important;}";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}"><base target="_blank"><meta name="color-scheme" content="${rich ? "light" : "dark"}"><style>
html,body{margin:0;padding:0;touch-action:pan-y;}
body{display:flow-root;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Geist,Helvetica,Arial,sans-serif;overflow-wrap:anywhere;padding:${rich ? "20px" : "0"};}
img{max-width:100%;height:auto;}
table{max-width:100%;}
pre{white-space:pre-wrap;}
blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:2px solid ${rich ? "#ddd" : "#3a3a3a"};}
${theme}
</style></head><body>${html}</body></html>`;
}

export default function EmailFrame({
  html,
  rich,
  title,
  swipe,
}: {
  html: string;
  rich: boolean;
  title: string;
  swipe?: () => SwipeHandlers;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(rich ? 320 : 80);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let observer: ResizeObserver | null = null;
    let unwatch: (() => void) | null = null;
    const measure = () => {
      const body = element.contentDocument?.body;
      if (!body) return;
      setHeight(Math.max(24, Math.ceil(body.scrollHeight)));
    };
    const attach = () => {
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
    element.addEventListener("load", attach);
    if (element.contentDocument?.readyState === "complete") attach();
    return () => {
      element.removeEventListener("load", attach);
      observer?.disconnect();
      unwatch?.();
    };
  }, [html, swipe]);

  return (
    <iframe
      ref={frame}
      title={title}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={documentFor(html, rich)}
      className={cn("block w-full border-0", rich && "rounded-xl bg-white")}
      style={{ height }}
    />
  );
}
