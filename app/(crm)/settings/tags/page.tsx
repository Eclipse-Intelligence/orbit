import { redirect } from "next/navigation";
import { SettingsPage } from "@/components/crm/settings-ui";
import TagsSettings from "@/components/crm/tags-settings";
import { getUserActor } from "@/lib/auth/user";
import { listTags } from "@/lib/crm/tags";

export const dynamic = "force-dynamic";

export default async function TagSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const tags = await listTags(user);
  return (
    <SettingsPage
      title="Tags"
      description="Rename, merge or delete the tags on your contacts and companies."
    >
      <TagsSettings tags={tags} />
    </SettingsPage>
  );
}
