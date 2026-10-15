import { redirect } from "next/navigation";
import PipelineSettings from "@/components/crm/pipeline-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor } from "@/lib/auth/user";
import { listPipeline } from "@/lib/crm/opportunities";

export const dynamic = "force-dynamic";

export default async function PipelineSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const pipeline = await listPipeline(user);
  return (
    <SettingsPage
      title="Pipeline"
      description="The stages an opportunity moves through, and how likely each one is to close."
    >
      <PipelineSettings stages={pipeline.stages} />
    </SettingsPage>
  );
}
