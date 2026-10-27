import { redirect } from "next/navigation";
import KnowledgePanel from "@/components/knowledge/knowledge-panel";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor } from "@/lib/auth/user";
import { resumeStale } from "@/lib/knowledge/background";
import { listKnowledge } from "@/lib/knowledge/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function KnowledgeSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const items = await listKnowledge(user, { eclipse: true });
  resumeStale(user, items);
  return (
    <SettingsPage title="Knowledge" description="Documents and links the assistant searches. Add company material on each company page.">
      <KnowledgePanel target={{ eclipse: true }} initial={items} variant="settings" />
    </SettingsPage>
  );
}
