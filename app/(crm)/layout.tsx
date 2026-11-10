import KeepPageInPlace from "@/components/_common/keep-page-in-place";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { after } from "next/server";
import Sidebar from "@/components/_common/sidebar/sidebar";
import CrmChrome from "@/components/crm/chrome";
import DocsProvider from "@/components/docs/docs-provider";
import MailUnread from "@/components/mail/mail-unread";
import { ShortcutsProvider } from "@/components/shortcuts/shortcuts-provider";
import { getHomeActor, getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import { syncCalendar } from "@/lib/crm/calendar";
import { syncCalls } from "@/lib/crm/calls";
import { syncClickUp } from "@/lib/crm/clickup";
import { listBoards } from "@/lib/crm/boards";
import { countCompanies } from "@/lib/crm/companies";
import { syncGranolaOnVisit } from "@/lib/crm/granola";
import { runWorkflowTick } from "@/lib/workflows/engine";
import { listNotifications } from "@/lib/workflows/store";
import { countOpenTasks } from "@/lib/crm/tasks";
import { captureStatuses } from "@/lib/crm/capture";
import { unreadBrief } from "@/lib/learning/nightly";
import { syncTeamsTranscripts } from "@/lib/crm/teams-transcripts";
import { processDueMail } from "@/lib/mail/due";
import { classifyCapture } from "@/lib/mail/capture-filter";
import { syncMail } from "@/lib/mail/sync";
import { noteViewerAddress } from "@/lib/mail/tracking";
import { clickupToken } from "@/lib/clickup";
import { microsoftConfigured } from "@/lib/microsoft/oauth";
import { docsSeed, emptyDocsNav } from "@/lib/docs/server";

export const dynamic = "force-dynamic";

export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const [user, home, workspaces] = await Promise.all([getUserActor(), getHomeActor(), getWorkspaceChoices()]);
  if (!user || !home) redirect("/login");
  if (microsoftConfigured()) {
    after(async () => {
      try {
        const result = await syncCalls(home);
        if (result.ran && result.error) console.error("Teams call sync failed", result.error);
      } catch (error) {
        console.error("Teams call sync failed", error);
      }
      try {
        const result = await syncCalendar(home);
        if (result.ran && result.error) console.error("Calendar sync failed", result.error);
      } catch (error) {
        console.error("Calendar sync failed", error);
      }
      try {
        const result = await syncTeamsTranscripts(home);
        if (result.ran && result.error) console.error("Teams transcript sync failed", result.error);
      } catch (error) {
        console.error("Teams transcript sync failed", error);
      }
    });
  }
  if (microsoftConfigured()) {
    after(async () => {
      try {
        const result = await syncMail(home, { budgetMs: 10_000, backfill: false });
        if (result.errors.length) console.error("Mail sync failed", result.errors.join("; "));
        await processDueMail(home);
        await classifyCapture(home, { budgetMs: 20_000, gapSeconds: 60 }).catch((error) =>
          console.error("Sorting Capture email failed", error instanceof Error ? error.message : error),
        );
      } catch (error) {
        console.error("Mail sync failed", error);
      }
    });
  }
  const viewerAddress = (await headers()).get("x-forwarded-for");
  after(async () => {
    try {
      await noteViewerAddress(home, viewerAddress);
    } catch (error) {
      console.error("Viewer address failed", error);
    }
  });
  after(async () => {
    try {
      await runWorkflowTick({ budgetMs: 20_000 });
    } catch (error) {
      console.error("Workflow tick failed", error);
    }
  });
  after(async () => {
    try {
      const result = await syncGranolaOnVisit(user);
      if (result?.ran && result.error) console.error("Granola sync failed", result.error);
    } catch (error) {
      console.error("Granola sync failed", error);
    }
  });
  if (clickupToken()) {
    after(async () => {
      try {
        const result = await syncClickUp({ actor: user });
        if (result.ran && result.error) console.error("ClickUp sync failed", result.error);
      } catch (error) {
        console.error("ClickUp sync failed", error);
      }
    });
  }
  const [companyCount, openActionCount, boards, notifications, captures, brief] = await Promise.all([
    countCompanies(user),
    countOpenTasks(user, { mine: true }),
    listBoards(user),
    listNotifications(user, 10),
    captureStatuses(user).catch(() => null),
    unreadBrief(user).catch(() => null),
  ]);

  const capture = captures?.get(user.workspaceId) ?? null;
  const choices = workspaces.map((item) => ({ ...item, waiting: item.id !== user.workspaceId && (captures?.get(item.id)?.fresh ?? 0) > 0 }));

  return (
    <ShortcutsProvider>
      <DocsProvider seed={docsSeed(user)} nav={emptyDocsNav(user)}>
        <main data-app-shell className="relative flex h-dvh max-w-full overflow-hidden">
          <KeepPageInPlace />
          <MailUnread />
          <Sidebar
            boards={boards}
            companyCount={companyCount}
            openActionCount={openActionCount}
            capture={capture}
            workspace={{
              id: user.workspaceId,
              name: user.workspaceName,
              viewerName: user.fullName || "",
              choices,
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
            brief={brief}
            multi={workspaces.length > 1}
          >
            {children}
          </CrmChrome>
        </main>
      </DocsProvider>
    </ShortcutsProvider>
  );
}
