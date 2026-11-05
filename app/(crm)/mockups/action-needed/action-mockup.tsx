"use client";

import type { ReactNode } from "react";
import Button from "@/components/_ui/button";
import SidebarNavItem from "@/components/_common/sidebar/sidebar-nav-item";
import { NewDot } from "@/components/_common/sidebar/sidebar-toggle";
import BellIcon from "@/public/assets/images/companies/header/bell.svg";
import MenuIcon from "@/public/assets/images/_common/menu.svg";
import PanelIcon from "@/public/assets/images/_common/sidebar-panel.svg";
import MailIcon from "@/public/assets/images/companies/sidebar/mail.svg";
import ActionList, { type ListOptions } from "./action-list";
import { BellPanel, MockFrame, type ChromeState } from "./mock-chrome";
import { EMPTY_DATA, JAMES_DATA, MARK_DATA, OTHERS_APPROVALS, PARTIAL_DATA, countOf, type ActionData, type Scene } from "./mock-data";

const MARK: ChromeState = {
  viewer: "Mark Ridgeon",
  role: "owner",
  active: "capture",
  captureCount: 0,
  captureNew: false,
  otherWorkspaceNew: true,
  tasks: 9,
  bellUnread: true,
};

const JAMES: ChromeState = { ...MARK, viewer: "James Carter", role: "member", otherWorkspaceNew: false, tasks: 4, bellUnread: false };

function liveCount(data: ActionData, cleared: string[] = []) {
  return countOf(data) - cleared.length;
}

export default function ActionMockup({ scene }: { scene: Scene }) {
  if (scene === "bell" || scene === "nav") return <BellScene sheet={scene === "nav"} />;

  const plan: Record<Exclude<Scene, "bell" | "nav">, { data: ActionData; state: ChromeState; options: ListOptions }> = {
    full: { data: MARK_DATA, state: MARK, options: { initialCleared: ["t0"], toast: "Task done. 19 left." } },
    approvals: { data: MARK_DATA, state: MARK, options: { initialFilter: "approvals", initialCleared: ["t0"] } },
    empty: { data: EMPTY_DATA, state: { ...MARK, bellUnread: false }, options: {} },
    partial: { data: PARTIAL_DATA, state: MARK, options: {} },
    rows: { data: MARK_DATA, state: MARK, options: { initialCleared: ["t0"], activeRow: "r2", openSnooze: "r2", initialFilter: "replies" } },
    swipe: { data: MARK_DATA, state: MARK, options: { initialCleared: ["t0"], initialFilter: "replies", swipes: [{ id: "r1", side: "left" }, { id: "r2", side: "right" }] } },
    menu: { data: MARK_DATA, state: MARK, options: { initialCleared: ["t0"], initialFilter: "replies", openMore: "r2" } },
    team: { data: MARK_DATA, state: MARK, options: { initialCleared: ["t0"], initialFilter: "approvals", others: OTHERS_APPROVALS } },
    colleague: { data: JAMES_DATA, state: JAMES, options: {} },
  };
  const chosen = plan[scene];
  const state = { ...chosen.state, captureCount: liveCount(chosen.data, chosen.options.initialCleared) };

  return (
    <MockFrame state={state} title="Capture">
      <ActionList data={chosen.data} options={chosen.options} />
    </MockFrame>
  );
}

function BellScene({ sheet }: { sheet: boolean }) {
  const count = liveCount(MARK_DATA, ["t0"]);
  const state: ChromeState = { ...MARK, active: "mail", captureCount: count, captureNew: true };
  return (
    <MockFrame
      state={state}
      title="Mail"
      sheet={sheet}
      bell={sheet ? undefined : <BellPanel count={count} summary="3 approvals, 4 follow-ups, 3 replies, 4 tasks, 5 to file" />}
    >
      <BadgeBoard count={count} />
    </MockFrame>
  );
}

function Board({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bg-card border-line-strong flex flex-col gap-3 rounded-2xl border p-4">
      <h2 className="eyebrow-style text-subtle font-normal">{title}</h2>
      {children}
    </section>
  );
}

function Variant({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="caption-style text-subtle">{label}</span>
      {children}
    </div>
  );
}

function BadgeBoard({ count }: { count: number }) {
  return (
    <div className="flex max-w-[30rem] flex-col gap-3">
      <Board title="Capture in the sidebar">
        <ul className="bg-sidebar flex flex-col gap-2 rounded-xl p-2">
          <Variant label="Waiting, nothing new">
            <SidebarNavItem icon={MailIcon} label="Capture" count={count} accent />
          </Variant>
          <Variant label="New since you last looked">
            <SidebarNavItem icon={MailIcon} label="Capture" count={count} accent dot dotLabel="New since you last looked" />
          </Variant>
          <Variant label="On Capture">
            <SidebarNavItem icon={MailIcon} label="Capture" count={count} accent active />
          </Variant>
          <Variant label="Nothing waiting">
            <SidebarNavItem icon={MailIcon} label="Capture" />
          </Variant>
        </ul>
      </Board>
      <Board title="When the sidebar is hidden">
        <div className="flex flex-col gap-3">
          <Variant label="Phone menu and collapsed sidebar">
            <span className="flex items-center gap-2">
              <Button variant="secondary" size="icon" className="relative" aria-label="Open navigation, new in Capture">
                <MenuIcon aria-hidden className="size-3.5" />
                <NewDot />
              </Button>
              <Button variant="secondary" size="icon" className="relative" aria-label="Expand sidebar, new in Capture">
                <PanelIcon aria-hidden className="size-3.5" />
                <NewDot />
              </Button>
            </span>
          </Variant>
          <Variant label="Bell: unread updates only, no tasks">
            <span className="flex items-center gap-2">
              <Button variant="secondary" size="icon" className="relative" aria-label="Notifications, unread">
                <BellIcon aria-hidden className="size-3.5" />
                <span className="bg-danger absolute top-1 right-1 size-1.5 rounded-full" />
              </Button>
              <Button variant="secondary" size="icon" aria-label="Notifications">
                <BellIcon aria-hidden className="size-3.5" />
              </Button>
            </span>
          </Variant>
          <Variant label="Workspace switcher: new in another workspace">
            <span className="caption-style text-subtle flex items-center gap-1">
              Eclipse
              <span aria-hidden className="bg-primary size-1.5 shrink-0 rounded-full" />
            </span>
          </Variant>
        </div>
      </Board>
    </div>
  );
}
