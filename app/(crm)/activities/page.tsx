import { redirect } from "next/navigation";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

export default async function ActivitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  const params = new URLSearchParams();
  for (const key of ["q", "type", "add"]) {
    const value = resolved[key];
    if (typeof value === "string" && value) params.set(key, value);
  }
  const query = params.toString();
  redirect(query ? `${SETTINGS_PATHS.activity}?${query}` : SETTINGS_PATHS.activity);
}
