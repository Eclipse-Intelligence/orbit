import { redirect } from "next/navigation";
import { after } from "next/server";
import Sidebar from "@/components/_common/sidebar/sidebar";
import CrmChrome from "@/components/crm/chrome";
import { getUserActor } from "@/lib/auth/user";
import { syncCalls } from "@/lib/crm/calls";
import { countCompanies } from "@/lib/crm/companies";
import { syncGranola } from "@/lib/crm/granola";
import { listAttention } from "@/lib/crm/relationships";
import { countOpenTasks } from "@/lib/crm/tasks";
import { syncTeamsTranscripts } from "@/lib/crm/teams-transcripts";
import { granolaApiKey } from "@/lib/granola";
import { microsoftConfigured } from "@/lib/microsoft/oauth";

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
        const result = await syncTeamsTranscripts(user);
        if (result.ran && result.error) console.error("Teams transcript sync failed", result.error);
      } catch (error) {
        console.error("Teams transcript sync failed", error);
      }
    });
  }
  if (granolaApiKey()) {
    after(async () => {
      try {
        const result = await syncGranola();
        if (result.ran && result.error) console.error("Granola sync failed", result.error);
      } catch (error) {
        console.error("Granola sync failed", error);
      }
    });
  }
  const [companyCount, openActionCount, attention] = await Promise.all([
    countCompanies(user),
    countOpenTasks(user),
    listAttention(user),
  ]);

  return (
    <main className="flex h-dvh max-w-full overflow-hidden">
      <Sidebar
        companyCount={companyCount}
        openActionCount={openActionCount}
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
    >
        {children}
      </CrmChrome>
    </main>
  );
}
