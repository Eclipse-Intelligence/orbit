import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { after } from "next/server";
import Sidebar from "@/components/_common/sidebar/sidebar";
import CrmChrome from "@/components/crm/chrome";
import DocsProvider from "@/components/docs/docs-provider";
import { ShortcutsProvider } from "@/components/shortcuts/shortcuts-provider";
import { getUserActor } from "@/lib/auth/user";
import { syncCalendar } from "@/lib/crm/calendar";
import { syncCalls } from "@/lib/crm/calls";
import { syncClickUp } from "@/lib/crm/clickup";
import { listBoards } from "@/lib/crm/boards";
import { countCompanies } from "@/lib/crm/companies";
import { syncGranolaOnVisit } from "@/lib/crm/granola";
import { runWorkflowTick } from "@/lib/workflows/engine";
import { countApprovals, listNotifications } from "@/lib/workflows/store";
import { listAttention } from "@/lib/crm/relationships";
import { countOpenTasks } from "@/lib/crm/tasks";
import { syncTeamsTranscripts } from "@/lib/crm/teams-transcripts";
import { processDueMail } from "@/lib/mail/due";
import { syncMail } from "@/lib/mail/sync";
import { mailUnreadCount } from "@/lib/mail/threads";
import { noteViewerAddress } from "@/lib/mail/tracking";
import { clickupToken } from "@/lib/clickup";
import { microsoftConfigured } from "@/lib/microsoft/oauth";
import { docsSeed, loadDocsNav } from "@/lib/docs/server";

export const dynamic = "force-dynamic";

export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  if (microsoftConfigured()) {
    after(async () => {
      try {
        const result = await syncCalls(user);
        if (result.ran && result.error) console.error("Teams call sync failed", result.error);
      } catch (error) {
        console.error("Teams call sync failed", error);
      }
      try {
        const result = await syncCalendar(user);
        if (result.ran && result.error) console.error("Calendar sync failed", result.error);
      } catch (error) {
        console.error("Calendar sync failed", error);
      }
      try {
        const result = await syncTeamsTranscripts(user);
        if (result.ran && result.error) console.error("Teams transcript sync failed", result.error);
      } catch (error) {
        console.error("Teams transcript sync failed", error);
      }
    });
  }
  if (microsoftConfigured()) {
    after(async () => {
      try {
        const result = await syncMail(user, { budgetMs: 10_000, backfill: false });
        if (result.errors.length) console.error("Mail sync failed", result.errors.join("; "));
        await processDueMail(user);
      } catch (error) {
        console.error("Mail sync failed", error);
      }
    });
  }
  const viewerAddress = (await headers()).get("x-forwarded-for");
  after(async () => {
    try {
      await noteViewerAddress(user, viewerAddress);
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
  const [companyCount, openActionCount, attention, boards, notifications, approvals, mailUnread, docsNav] = await Promise.all([
    countCompanies(user),
    countOpenTasks(user, { mine: true }),
    listAttention(user),
    listBoards(user),
    listNotifications(user, 10),
    countApprovals(user),
    mailUnreadCount(user).catch(() => 0),
    loadDocsNav(user),
  ]);

  return (
    <ShortcutsProvider>
      <DocsProvider seed={docsSeed(user)} nav={docsNav}>
        <main className="relative flex h-dvh max-w-full overflow-hidden">
          <Sidebar
            boards={boards}
            approvals={approvals}
            companyCount={companyCount}
            openActionCount={openActionCount}
            mailUnread={mailUnread}
            workspaceName={user.workspaceName}
          />
          <CrmChrome
            viewer={{
              id: user.userId,
              name: user.fullName || user.email,
              email: user.email,
              role: user.role,
              workspaceName: user.workspaceName,
            }}
            overdue={attention.overdue}
            today={attention.today}
            notifications={notifications}
          >
            {children}
          </CrmChrome>
        </main>
      </DocsProvider>
    </ShortcutsProvider>
  );
}
