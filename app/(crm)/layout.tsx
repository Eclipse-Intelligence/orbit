import KeepPageInPlace from "@/components/_common/keep-page-in-place";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { after } from "next/server";
import Sidebar from "@/components/_common/sidebar/sidebar";
import CrmChrome from "@/components/crm/chrome";
import { FindAvailabilityProvider } from "@/components/crm/find-availability";
import DocsProvider from "@/components/docs/docs-provider";
import ChatLive from "@/components/chat/chat-live";
import SyncSignals from "@/components/crm/sync-signals";
import MailUnread from "@/components/mail/mail-unread";
import CaptureStatus from "@/components/capture/capture-status";
import CampaignsWaiting from "@/components/campaigns/campaigns-waiting";
import { ShortcutsProvider } from "@/components/shortcuts/shortcuts-provider";
import { getHomeActor, getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import { syncClickUp } from "@/lib/crm/clickup";
import { listBoards } from "@/lib/crm/boards";
import { countCompanies } from "@/lib/crm/companies";
import { syncGranolaOnVisit } from "@/lib/crm/granola";
import { teamUnreadCount } from "@/lib/mail/notify";
import { BELL_LIMIT, listNotifications } from "@/lib/workflows/store";
import { countOpenTasks } from "@/lib/crm/tasks";
import { unreadBrief } from "@/lib/learning/nightly";
import { noteViewerAddress } from "@/lib/mail/tracking";
import { clickupToken } from "@/lib/clickup";
import { docsSeed, emptyDocsNav } from "@/lib/docs/server";
import { enrichmentAvailability } from "@/lib/enrichment/settings";
import { visitDue } from "@/lib/visit-throttle";

export const dynamic = "force-dynamic";

async function renderStamp() {
  return Date.now();
}

const VISIT_SYNC_GAP_MS = 5 * 60 * 1000;
const VIEWER_GAP_MS = 60 * 60 * 1000;

export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const [user, home, workspaces] = await Promise.all([getUserActor(), getHomeActor(), getWorkspaceChoices()]);
  if (!user || !home) redirect("/login");
  const viewerAddress = (await headers()).get("x-forwarded-for");
  if (viewerAddress && visitDue(`viewer:${user.userId}:${viewerAddress}`, VIEWER_GAP_MS)) {
    after(async () => {
      try {
        await noteViewerAddress(home, viewerAddress);
      } catch (error) {
        console.error("Viewer address failed", error);
      }
    });
  }
  if (visitDue(`granola:${user.userId}`, VISIT_SYNC_GAP_MS)) {
    after(async () => {
      try {
        const result = await syncGranolaOnVisit(user);
        if (result?.ran && result.error) console.error("Granola sync failed", result.error);
      } catch (error) {
        console.error("Granola sync failed", error);
      }
    });
  }
  if (clickupToken() && visitDue(`clickup:${user.workspaceId}`, VISIT_SYNC_GAP_MS)) {
    after(async () => {
      try {
        const result = await syncClickUp({ actor: user });
        if (result.ran && result.error) console.error("ClickUp sync failed", result.error);
      } catch (error) {
        console.error("ClickUp sync failed", error);
      }
    });
  }
  const [companyCount, openActionCount, boards, notifications, brief, teamUnread] = await Promise.all([
    countCompanies(user),
    countOpenTasks(user, { mine: true }),
    listBoards(user),
    listNotifications(user, BELL_LIMIT),
    unreadBrief(user).catch(() => null),
    teamUnreadCount(user).catch(() => 0),
  ]);

  const enrichment = enrichmentAvailability();
  const renderedAt = await renderStamp();

  return (
    <ShortcutsProvider>
      <DocsProvider seed={docsSeed(user)} nav={emptyDocsNav(user)}>
        <FindAvailabilityProvider value={{ phone: enrichment.phone, email: enrichment.email }}>
          <main data-app-shell className="relative flex h-dvh max-w-full overflow-hidden">
            <KeepPageInPlace />
            <MailUnread />
            <CaptureStatus renderedAt={renderedAt} />
            <CampaignsWaiting />
            <ChatLive />
            <SyncSignals />
            <Sidebar
              boards={boards}
              companyCount={companyCount}
              openActionCount={openActionCount}
              workspace={{
                id: user.workspaceId,
                name: user.workspaceName,
                viewerName: user.fullName || "",
                choices: workspaces,
              }}
            />
            <CrmChrome
              viewer={{
                id: user.userId,
                name: user.fullName || user.email,
                email: user.email,
                role: user.role,
                workspaceName: user.workspaceName,
                workspaceId: user.workspaceId,
              }}
              notifications={notifications}
              teamUnread={teamUnread}
              brief={brief}
              multi={workspaces.length > 1}
            >
              {children}
            </CrmChrome>
          </main>
        </FindAvailabilityProvider>
      </DocsProvider>
    </ShortcutsProvider>
  );
}
