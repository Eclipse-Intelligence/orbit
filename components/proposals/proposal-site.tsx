"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import ProposalDocument, { Signatures, type SiteExtras } from "@/components/proposals/proposal-document";
import { shows, tabsOf, type Content } from "@/lib/proposals/model";
import { cn } from "@/lib/utils";

type SignatureView = Parameters<typeof Signatures>[0]["signatures"][number];

export const SIGN_TAB = "sign";

export default function ProposalSite({
  content,
  signatures = [],
  children,
  compact,
  active: controlled,
  onActive,
  signLabel = "Sign",
  sticky,
  followHash,
  extras,
}: {
  content: Content;
  signatures?: SignatureView[];
  children?: ReactNode;
  compact?: boolean;
  active?: string;
  onActive?: (slug: string) => void;
  signLabel?: string;
  sticky?: string;
  followHash?: boolean;
  extras?: SiteExtras;
}) {
  const all = tabsOf(content.blocks);
  const tabs = all && !extras?.preview ? all.filter((tab) => tab.blocks.some((block) => shows(block, { booking: Boolean(extras?.booking), steps: extras?.steps ? extras.steps.length > 0 : undefined }))) : all;
  const [own, setOwn] = useState(tabs?.[0]?.slug ?? SIGN_TAB);
  const requested = controlled ?? own;
  const list = useRef<HTMLDivElement>(null);
  const base = useId();
  const choose = (slug: string) => {
    if (onActive) onActive(slug);
    else setOwn(slug);
  };

  const slugs = tabs ? tabs.map((tab) => tab.slug).join(" ") : "";

  useEffect(() => {
    if (!followHash || !slugs) return;
    const known = new Set([...slugs.split(" "), SIGN_TAB]);
    const read = () => {
      const slug = window.location.hash.slice(1);
      if (!known.has(slug)) return;
      if (onActive) onActive(slug);
      else setOwn(slug);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [followHash, slugs, onActive]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [requested]);

  if (!tabs) {
    return (
      <ProposalDocument content={content} signatures={signatures} compact={compact} extras={extras}>
        {children}
      </ProposalDocument>
    );
  }

  const entries = [...tabs.map((tab) => ({ slug: tab.slug, label: tab.label })), { slug: SIGN_TAB, label: signLabel }];
  const active = entries.some((entry) => entry.slug === requested) ? requested : entries[0].slug;
  const current = tabs.find((tab) => tab.slug === active);

  function select(slug: string) {
    choose(slug);
    if (followHash) window.history.replaceState(null, "", `#${slug}`);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = entries.findIndex((entry) => entry.slug === active);
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + entries.length) % entries.length;
    select(entries[next].slug);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  }

  return (
    <div className={cn("flex flex-col", compact ? "gap-8" : "gap-10 sm:gap-12")}>
      <div className={cn("paper -mx-5 px-5 sm:-mx-8 sm:px-8", sticky && "sticky z-10", sticky)}>
        <div
          ref={list}
          role="tablist"
          aria-label="Sections"
          onKeyDown={onKeyDown}
          className="border-border flex gap-1 overflow-x-auto border-b [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {entries.map((entry) => {
            const selected = entry.slug === active;
            return (
              <button
                key={entry.slug}
                type="button"
                role="tab"
                id={`${base}-${entry.slug}-tab`}
                aria-selected={selected}
                aria-controls={`${base}-${entry.slug}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => select(entry.slug)}
                className={cn(
                  "relative -mb-px flex h-12 shrink-0 cursor-pointer items-center px-3 text-[14.5px] whitespace-nowrap outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-inset sm:px-4",
                  selected ? "text-foreground font-semibold" : "text-subtle hover:text-foreground",
                )}
              >
                {entry.label}
                <span
                  aria-hidden
                  className={cn("absolute inset-x-3 bottom-0 h-0.5 rounded-full transition-opacity duration-150 sm:inset-x-4", selected ? "opacity-100" : "opacity-0")}
                  style={{ backgroundColor: content.accent }}
                />
              </button>
            );
          })}
        </div>
      </div>
      <div role="tabpanel" id={`${base}-${active}-panel`} aria-labelledby={`${base}-${active}-tab`} tabIndex={-1} className="outline-none">
        {current ? (
          <ProposalDocument content={content} blocks={current.blocks} compact={compact} withSignatures={false} extras={extras} />
        ) : (
          <Signatures content={content} signatures={signatures}>
            {children}
          </Signatures>
        )}
      </div>
    </div>
  );
}
