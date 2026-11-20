"use client";

import { useEffect, useState } from "react";
import { ProposalLogo } from "@/components/proposals/proposal-document";
import { isDarkLogo } from "@/lib/proposals/logo-shade";
import { bandAccent, businessLines, longDate, senderCompany, type Block, type Content } from "@/lib/proposals/model";
import { cn } from "@/lib/utils";

export const BAND_BASE = "#0e0e12";

function channels(hex: string) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return match ? match.slice(1).map((part) => parseInt(part, 16)) : null;
}

function bandBackground(accent: string) {
  const rgb = channels(accent);
  const glow = rgb ? `radial-gradient(60em 26em at 88% -20%, rgb(${rgb.join(" ")} / 0.2), transparent 70%), ` : "";
  return `${glow}radial-gradient(40em 20em at 0% 0%, rgb(255 255 255 / 0.045), transparent 70%), linear-gradient(180deg, #19191f 0%, ${BAND_BASE} 100%)`;
}

export function useLogoDark(src: string | null | undefined, initial = true) {
  const [dark, setDark] = useState(initial);
  useEffect(() => {
    if (!src) return;
    let live = true;
    const image = new window.Image();
    image.onload = () => {
      const scale = Math.min(1, 160 / Math.max(image.naturalWidth, image.naturalHeight, 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context || !live) return;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      try {
        setDark(isDarkLogo(context.getImageData(0, 0, canvas.width, canvas.height).data));
      } catch {
        setDark(false);
      }
    };
    image.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  return dark;
}

export default function ProposalBand({ content, logoDark, compact, rounded }: { content: Content; logoDark?: boolean; compact?: boolean; rounded?: "top" | "all" }) {
  const cover = content.blocks.find((block): block is Extract<Block, { type: "cover" }> => block.type === "cover");
  const white = useLogoDark(content.logo, logoDark ?? true);
  const lines = businessLines(content.business);
  return (
    <header className={cn("night", rounded === "top" && "rounded-t-2xl", rounded === "all" && "rounded-2xl")} style={{ background: bandBackground(content.accent) }}>
      <div className={cn("mx-auto flex max-w-[56em] flex-col", compact ? "gap-10 px-5 pt-7 pb-9 sm:px-7" : "gap-12 px-5 pt-8 pb-10 sm:gap-16 sm:px-8 sm:pt-10 sm:pb-14")}>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
          {content.logo ? (
            <ProposalLogo src={content.logo} company={senderCompany(content)} white={white} className="h-9 w-36 shrink-0 max-sm:h-8 max-sm:w-32" />
          ) : (
            <span aria-hidden className="mt-1 block h-1.5 w-14 shrink-0 rounded-full" style={{ backgroundColor: bandAccent(content.accent) }} />
          )}
          {lines.length > 0 && (
            <address className="text-subtle flex flex-col gap-0.5 text-[12.5px] leading-5 not-italic sm:items-end sm:text-right">
              {lines.map((line) =>
                line.key === "name" ? (
                  <span key={line.key} className="text-foreground font-medium">
                    {line.text}
                  </span>
                ) : line.href ? (
                  <a
                    key={line.key}
                    href={line.href}
                    target={line.key === "website" ? "_blank" : undefined}
                    rel={line.key === "website" ? "noreferrer" : undefined}
                    className="hover:text-foreground break-words underline-offset-2 transition-colors duration-150 hover:underline"
                  >
                    {line.text}
                  </a>
                ) : (
                  <span key={line.key} className="break-words whitespace-pre-line">
                    {line.text}
                  </span>
                ),
              )}
            </address>
          )}
        </div>
        <div className="flex flex-col gap-4">
          <h1 className="doc-title">{cover?.title || content.title}</h1>
          {cover?.subtitle && <p className="doc-lead text-soft max-w-[34em]">{cover.subtitle}</p>}
          <dl className="text-subtle flex flex-wrap gap-x-6 gap-y-1 text-[13.5px]">
            <div className="flex gap-1.5">
              <dt>Issued</dt>
              <dd className="text-foreground">{longDate(content.issuedAt)}</dd>
            </div>
            {content.validUntil && (
              <div className="flex gap-1.5">
                <dt>Valid until</dt>
                <dd className="text-foreground">{longDate(content.validUntil)}</dd>
              </div>
            )}
            <div className="flex gap-1.5">
              <dt>From</dt>
              <dd className="text-foreground">{content.sender.name}</dd>
            </div>
          </dl>
        </div>
      </div>
    </header>
  );
}
