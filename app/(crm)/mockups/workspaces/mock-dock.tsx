"use client";

import Button from "@/components/_ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/_ui/select";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import ArrowUpIcon from "@/public/assets/images/assistant/arrow-up.svg";
import GlobeIcon from "@/public/assets/images/assistant/globe.svg";
import ClockIcon from "@/public/assets/images/companies/detail/clock.svg";
import type { MockWorkspace } from "./mock-data";
import { WorkspaceTile } from "./mock-shell";

const PROMPTS = {
  ridgeon: ["What needs a reply from me today?", "Draft the Q1 retainer note for Halden", "Which consulting leads have gone quiet?"],
  eclipse: ["What needs a reply from me today?", "Summarise what customers emailed this week", "Draft a follow-up to anyone who hasn't replied"],
};

export function DockOpen({ workspace }: { workspace: MockWorkspace }) {
  return (
    <div className="fixed inset-x-2 top-16 bottom-2 z-40 md:inset-x-auto md:top-auto md:bottom-4 md:left-1/2 md:w-[min(46rem,calc(100vw-2rem))] md:-translate-x-1/2 lg:left-[calc(var(--sidebar-width)+(100vw-var(--sidebar-width))/2)] lg:w-[min(46rem,calc(100vw-var(--sidebar-width)-3rem))]">
      <section
        aria-label="Orbit assistant"
        className="relative flex h-full max-h-full flex-col overflow-hidden rounded-3xl bg-[#1c1c1c]/95 shadow-[0_24px_80px_rgba(0,0,0,0.6)] backdrop-blur-xl md:h-auto md:max-h-[min(44rem,calc(100dvh-6rem))]"
      >
        <header className="flex h-11 shrink-0 items-center gap-1 pt-1 pr-2 pl-4">
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span
              title={`Working in ${workspace.name}`}
              className="text-soft flex h-[22px] shrink-0 items-center gap-1.5 rounded-full bg-white/[0.05] pr-2 pl-[3px] text-[12px] leading-none"
            >
              <WorkspaceTile workspace={workspace} className="size-4 rounded-full text-[9px]" />
              {workspace.name}
            </span>
            <span className="text-subtle min-w-0 truncate text-[13px]">New chat</span>
          </span>
          <Button variant="ghost" size="icon-sm" aria-label="Past chats" title="Past chats">
            <ClockIcon aria-hidden className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="New chat" title="New chat">
            <PlusIcon aria-hidden className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Minimise" title="Minimise (Esc)">
            <ChevronDownIcon aria-hidden className="size-3" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-3 md:flex-none">
          <div className="flex flex-col gap-3 pt-1 pb-2">
            <ul className="flex flex-wrap gap-1.5" aria-label="Suggestions">
              {PROMPTS[workspace.id].map((prompt) => (
                <li key={prompt}>
                  <button
                    type="button"
                    className="text-soft hover:text-foreground focus-visible:ring-ring/60 rounded-full bg-white/[0.05] px-3 py-1.5 text-left text-[13px] leading-5 transition-colors duration-150 outline-none hover:bg-white/[0.09] focus-visible:ring-2"
                  >
                    {prompt}
                  </button>
                </li>
              ))}
            </ul>
            <p className="caption-style text-subtle">
              Works with {workspace.name}&apos;s records, brand profile and Knowledge. Your mail and calendar are all here. Changes need your approval.
            </p>
          </div>
        </div>
        <form className="shrink-0 px-5 pt-1 pb-3">
          <div className="flex flex-col gap-2">
            <label htmlFor="mock-assistant-input" className="sr-only">
              Message Orbit
            </label>
            <textarea
              id="mock-assistant-input"
              rows={1}
              placeholder={`Ask Orbit in ${workspace.name}… Type @ to tag`}
              className="placeholder:text-subtle text-foreground block min-h-6 w-full resize-none bg-transparent text-[14px] leading-6 outline-none [@media(pointer:coarse)]:text-[16px]"
            />
            <div className="flex items-center gap-1.5">
              <Select defaultValue="sonnet">
                <SelectTrigger aria-label="Model" className="-ml-2.5 h-7 w-auto gap-1.5 rounded-full border-transparent bg-transparent px-2.5 text-[12.5px] whitespace-nowrap hover:bg-white/5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent side="top" align="start">
                  <SelectItem value="sonnet">Sonnet 5.5</SelectItem>
                </SelectContent>
              </Select>
              <Select defaultValue="medium">
                <SelectTrigger aria-label="Reasoning" className="h-7 w-auto gap-1.5 rounded-full border-transparent bg-transparent px-2.5 text-[12.5px] whitespace-nowrap hover:bg-white/5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent side="top" align="start">
                  <SelectItem value="medium">Medium</SelectItem>
                </SelectContent>
              </Select>
              <button
                type="button"
                aria-pressed
                className="focus-visible:ring-ring/60 text-foreground flex h-7 cursor-pointer items-center gap-1.5 rounded-full bg-white/[0.08] px-2.5 text-[12.5px] outline-none focus-visible:ring-2"
              >
                <GlobeIcon aria-hidden className="size-3.5" />
                <span className="max-sm:sr-only">Web</span>
              </button>
              <Button variant="ghost" size="sm" aria-label="Attach files" title="Attach files" className="size-8 p-0">
                <PaperclipIcon aria-hidden className="size-3.5" />
              </Button>
              <span className="flex-1" />
              <Button variant="primary" size="icon" type="submit" aria-label="Send" disabled>
                <ArrowUpIcon aria-hidden className="size-3.5" />
              </Button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
