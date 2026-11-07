import { redirect } from "next/navigation";
import SettingsIndex from "@/components/crm/settings-index";
import { settingsRedirect } from "@/lib/settings-nav";
import GeneralSettings from "./general/general-settings";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of [value ?? []].flat()) query.append(key, item);
  }
  if (query.size) redirect(settingsRedirect(query));
  return (
    <div className="hidden lg:block">
      <SettingsIndex />
      <GeneralSettings />
    </div>
  );
}
