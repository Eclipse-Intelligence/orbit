import { redirect } from "next/navigation";
import CrmChrome from "@/components/crm/chrome";
import { ShortcutsProvider } from "@/components/shortcuts/shortcuts-provider";
import DocsMockupSidebar from "@/components/docs-mockup/sidebar";
import { MOCK_VIEWER } from "@/components/docs-mockup/data";
import { getUserActor } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

export const metadata = { title: "Docs" };

export default async function DocsMockupLayout({ children }: { children: React.ReactNode }) {
  const user = await getUserActor();
  if (!user) redirect("/login");

  return (
    <ShortcutsProvider>
      <main className="relative flex h-dvh max-w-full overflow-hidden">
        <DocsMockupSidebar />
        <CrmChrome viewer={MOCK_VIEWER} overdue={[]} today={[]} notifications={[]}>
          {children}
        </CrmChrome>
      </main>
    </ShortcutsProvider>
  );
}
