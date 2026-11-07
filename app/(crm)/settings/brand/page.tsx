import { redirect } from "next/navigation";
import BrandSettings from "@/components/crm/brand-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import { getBrand } from "@/lib/crm/brand";
import { listProof } from "@/lib/crm/proof";
import { listKnowledge } from "@/lib/knowledge/store";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export default async function BrandSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [brand, proof, knowledge, workspaces] = await Promise.all([
    getBrand(user),
    listProof(user).catch(() => []),
    listKnowledge(user, { eclipse: true }).catch(() => []),
    getWorkspaceChoices(),
  ]);
  return (
    <SettingsPage title="Brand" description={`What the assistant knows about ${user.workspaceName} when it writes, researches and drafts cold email.`}>
      <BrandSettings
        brand={brand}
        canEdit={user.role === "owner" || user.role === "admin"}
        proofCount={proof.length}
        knowledgeCount={knowledge.length}
        multi={workspaces.length > 1}
      />
    </SettingsPage>
  );
}
