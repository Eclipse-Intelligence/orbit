import { redirect } from "next/navigation";
import Sidebar from "@/components/_common/sidebar/sidebar";
import CrmChrome from "@/components/crm/chrome";
import { getUserActor } from "@/lib/auth/user";
import { countCompanies } from "@/lib/crm/companies";
import { listAttention } from "@/lib/crm/relationships";
import { countOpenTasks } from "@/lib/crm/tasks";

export const dynamic = "force-dynamic";

export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const user = await getUserActor();
  if (!user) redirect("/login");
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
