"use client";

import type { ReactNode } from "react";
import type { Viewer } from "@/components/crm/viewer";
import BrowserFrame, { PanelCrop, type Tab } from "./browser-frame";
import { CompanyPage, MessagingPage, ProfilePage, SalesNavPage } from "./fake-pages";
import { ECLIPSE, HANNAH, KESTREL, NORTHLIGHT, PRIYA, THREAD, TOM, type Scene } from "./mock-data";
import { CompanyPanel, NewCompanyPanel } from "./panel-company";
import { ApprovePage, ConnectPanel, TokenPanel, WaitingPanel } from "./panel-connect";
import { ConversationPanel, ConversationPickPanel } from "./panel-conversation";
import { InOrbitPanel, NewPersonPanel, SalesNavPanel } from "./panel-person";
import SettingsMock from "./settings-mock";

type Frame = { url: string; tabs: Tab[]; badge?: "in" | "maybe" | null; page: ReactNode; panel: ReactNode };

function linkedinTab(title: string, others: Tab[] = []): Tab[] {
  return [{ title, active: true }, ...others];
}

function frameFor(scene: Exclude<Scene, "settings">): Frame {
  const hannah = { url: `linkedin.com/in/${HANNAH.slug}`, tabs: linkedinTab(`${HANNAH.name} | Profile`), page: <ProfilePage person={HANNAH} /> };
  const priya = { url: `linkedin.com/in/${PRIYA.slug}`, tabs: linkedinTab(`${PRIYA.name} | Profile`), badge: "in" as const, page: <ProfilePage person={PRIYA} /> };
  const thread = { url: "linkedin.com/messaging/thread/2-MWE4ZjQ", tabs: linkedinTab("Messaging"), badge: "in" as const, page: <MessagingPage person={PRIYA} messages={THREAD} /> };
  switch (scene) {
    case "new-person":
      return { ...hannah, panel: <NewPersonPanel workspace={ECLIPSE} /> };
    case "workspace":
      return { ...hannah, panel: <NewPersonPanel workspace={ECLIPSE} menu /> };
    case "in-orbit":
      return { ...priya, panel: <InOrbitPanel workspace={ECLIPSE} /> };
    case "in-orbit-task":
      return { ...priya, panel: <InOrbitPanel workspace={ECLIPSE} active="task" /> };
    case "in-orbit-note":
      return { ...priya, panel: <InOrbitPanel workspace={ECLIPSE} active="note" /> };
    case "in-orbit-message":
      return { ...priya, panel: <InOrbitPanel workspace={ECLIPSE} active="message" /> };
    case "in-orbit-update":
      return { ...priya, panel: <InOrbitPanel workspace={ECLIPSE} active="update" /> };
    case "conversation":
      return { ...thread, panel: <ConversationPanel workspace={ECLIPSE} /> };
    case "conversation-pick":
      return { ...thread, panel: <ConversationPickPanel workspace={ECLIPSE} /> };
    case "sales-nav":
      return {
        url: "linkedin.com/sales/lead/ACwAAB9xK2sBr4,NAME_SEARCH",
        tabs: linkedinTab(`${TOM.name} | Sales Navigator`),
        badge: "maybe",
        page: <SalesNavPage person={TOM} />,
        panel: <SalesNavPanel workspace={ECLIPSE} />,
      };
    case "connect":
      return { ...hannah, panel: <ConnectPanel /> };
    case "connect-approve":
      return {
        url: "orbit.geteclipse.co/connect/chrome?code=KQ7M-4TXP",
        tabs: [{ title: `${HANNAH.name} | Profile` }, { title: "Connect Chrome extension", active: true, orbit: true }],
        page: <ApprovePage />,
        panel: <WaitingPanel />,
      };
    case "connect-token":
      return { ...hannah, panel: <TokenPanel /> };
    case "company":
      return {
        url: `linkedin.com/company/${NORTHLIGHT.slug}/about`,
        tabs: linkedinTab(`${NORTHLIGHT.name} | About`),
        badge: "in",
        page: <CompanyPage company={NORTHLIGHT} />,
        panel: <CompanyPanel workspace={ECLIPSE} />,
      };
    case "company-new":
      return {
        url: `linkedin.com/company/${KESTREL.slug}/about`,
        tabs: linkedinTab(`${KESTREL.name} | About`),
        page: <CompanyPage company={KESTREL} />,
        panel: <NewCompanyPanel workspace={ECLIPSE} />,
      };
  }
}

export default function LinkedinMockup({
  scene,
  crop,
  viewer,
  workspace,
}: {
  scene: Scene;
  crop: boolean;
  viewer: Viewer;
  workspace: { id: string; name: string };
}) {
  if (scene === "settings") return <SettingsMock viewer={viewer} workspace={workspace} />;
  const frame = frameFor(scene);
  if (crop) return <PanelCrop>{frame.panel}</PanelCrop>;
  return <BrowserFrame url={frame.url} tabs={frame.tabs} badge={frame.badge} page={frame.page} panel={frame.panel} />;
}
