"use client";

import { useLayoutEffect, useRef } from "react";
import Button from "@/components/_ui/button";
import Tag from "@/components/_ui/tag";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import { cn } from "@/lib/utils";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";

const DRAFT =
  "Hi Jane, thanks for your time on Tuesday. To recap: you want one shared pipeline for both sales teams, and a clean import from HubSpot before your April renewal. As a next step, how about 30 minutes with your ops lead next week to scope the import? Tuesday or Wednesday afternoon both work for me.";

function NoNextStepCard() {
  return (
    <li data-mock-focus="" className="bg-card border-line-strong flex flex-col gap-3 rounded-2xl border p-4">
      <div className="flex items-start gap-2.5">
        <Tag tone="purple" size="sm" className="text-[12px]">
          Teams
        </Tag>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[14px] leading-5">Demo with Acme ended with no next step</span>
          <span className="caption-style text-subtle leading-[1.4]">Tue 3 Nov with Jane Doe. Nothing has gone to Jane since. Orbit drafted a follow-up.</span>
        </span>
      </div>
      <div className="flex flex-col gap-1.5 rounded-xl bg-white/[0.035] px-3 py-2.5">
        <span className="caption-style text-subtle flex min-w-0 items-center gap-1.5">
          <SparkleIcon aria-hidden className="text-primary-foreground size-3 shrink-0" />
          <span className="truncate">To Jane Doe · Following up on the Acme demo</span>
        </span>
        <p className="text-soft line-clamp-6 text-[13px] leading-[1.5] sm:line-clamp-4">{DRAFT}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm">
          Review and send
        </Button>
        <Button variant="ghost" size="sm">
          Not needed
        </Button>
      </div>
    </li>
  );
}

function UnfiledCard() {
  return (
    <li className="bg-card border-line-strong flex flex-col gap-3 rounded-2xl border p-4">
      <div className="flex items-start gap-2.5">
        <Tag tone="teal" size="sm" className="text-[12px]">
          Granola
        </Tag>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[14px] leading-5">Intro with Northwind</span>
          <span className="caption-style text-subtle leading-[1.4]">3 Nov 2026, 15:00 · Tom Baker, Ana Ruiz</span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm">
          Create Tom Baker &amp; file
        </Button>
        <Button variant="secondary" size="sm">
          File to…
        </Button>
        <Button variant="ghost" size="sm">
          Ignore
        </Button>
      </div>
    </li>
  );
}

function NotificationsPanel() {
  const updates = [
    {
      title: "Demo with Acme ended with no next step",
      body: "Tue 3 Nov with Jane Doe. Orbit drafted a follow-up.",
      when: "Today",
      fresh: true,
    },
    {
      title: "Lunch on Thursday? is back in your inbox",
      body: "Nobody has replied. Orbit has a follow-up ready for you to send.",
      when: "Yesterday",
      fresh: false,
    },
  ];
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bell = document.querySelector('button[aria-label="Notifications"]');
    const element = panel.current;
    if (!bell || !element) return;
    const rect = bell.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 32);
    element.style.top = `${rect.bottom + 8}px`;
    element.style.left = `${Math.max(16, Math.min(rect.right - width, window.innerWidth - 16 - width))}px`;
    element.style.visibility = "visible";
  }, []);
  return (
    <div
      ref={panel}
      data-mock-popover=""
      className="border-line-strong bg-popover text-popover-foreground shadow-overlay invisible fixed z-50 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-xl border"
    >
      <div className="flex max-h-[min(560px,calc(100dvh-6rem))] flex-col gap-3 overflow-auto px-4 py-5">
        <h2>Notifications</h2>
        <ul className="flex flex-col gap-1">
          {updates.map((item) => (
            <li key={item.title}>
              <Button variant="ghost" size="sm" className="h-auto w-full items-start justify-start rounded-lg px-2 py-2 text-left whitespace-normal">
                <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", item.fresh ? "bg-primary" : "bg-transparent")} />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-foreground text-[14px] leading-5">{item.title}</span>
                  <span className="caption-style text-subtle line-clamp-2 whitespace-pre-line">{item.body}</span>
                  <span className="caption-style text-subtle">{item.when}</span>
                </span>
              </Button>
            </li>
          ))}
        </ul>
        <ul className="flex flex-col gap-2">
          <li>
            <Button variant="ghost" size="sm" className="h-auto w-full items-start justify-start rounded-lg px-2 py-2 text-left whitespace-normal">
              <span className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-[14px] leading-5">Send Brightwave the revised contract</span>
                <span className="caption-style text-subtle">Due · Brightwave · Today</span>
              </span>
            </Button>
          </li>
        </ul>
        <Button variant="subtle" size="sm" className="self-start">
          Open tasks
        </Button>
      </div>
    </div>
  );
}

export default function CaptureMock({ viewer, notifications }: { viewer: Viewer; notifications: boolean }) {
  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader title="Capture" viewer={viewer} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-24">
        <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6">
          <section aria-labelledby="follow-up-heading" className="flex flex-col gap-3">
            <h2 id="follow-up-heading" className="eyebrow-style text-subtle flex items-center gap-2 font-normal">
              Follow up
              <span className="text-soft tracking-normal tabular-nums">1</span>
            </h2>
            <ul className="flex flex-col gap-2">
              <NoNextStepCard />
            </ul>
          </section>
          <section aria-labelledby="to-file-heading" className="flex flex-col gap-3">
            <h2 id="to-file-heading" className="eyebrow-style text-subtle flex items-center gap-2 font-normal">
              To file
              <span className="text-soft tracking-normal tabular-nums">1</span>
            </h2>
            <section className="flex flex-col gap-2" aria-labelledby="unfiled-heading">
              <h3 id="unfiled-heading" className="h4-style">
                Meetings and calls with no contact
              </h3>
              <ul className="flex flex-col gap-2">
                <UnfiledCard />
              </ul>
            </section>
          </section>
        </div>
      </div>
      {notifications && <NotificationsPanel />}
    </section>
  );
}
