import { redirect } from "next/navigation";
import { SettingsPage } from "@/components/crm/settings-ui";
import LifecyclesSettings from "@/components/crm/lifecycles-settings";
import TagsSettings from "@/components/crm/tags-settings";
import { getUserActor } from "@/lib/auth/user";
import { listLifecycles } from "@/lib/crm/lifecycles";
import { listTags } from "@/lib/crm/tags";

export const dynamic = "force-dynamic";

export default async function TagSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [tags, lifecycles] = await Promise.all([listTags(user), listLifecycles(user)]);
  return (
    <SettingsPage
      title="Tags and lifecycles"
      description="Rename, merge or delete the tags on your contacts and companies, and the lifecycles on your companies."
    >
      <TagsSettings tags={tags} />
      <LifecyclesSettings lifecycles={lifecycles} />
    </SettingsPage>
  );
}
