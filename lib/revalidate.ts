import { revalidatePath } from "next/cache";
import { TASKS_PATH } from "@/lib/crm/task-views";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

export function revalidateRecordPages() {
  revalidatePath("/(crm)/companies/[id]", "page");
  revalidatePath("/(crm)/contacts/[id]", "page");
}

export const TASK_PAGE_PATHS: [string, "layout"?][] = [["/"], ["/contacts"], ["/opportunities"], ["/boards", "layout"], [SETTINGS_PATHS.activity], [TASKS_PATH], ["/calendar"]];

export function revalidateTaskPages() {
  for (const [path, type] of TASK_PAGE_PATHS) revalidatePath(path, type);
  revalidateRecordPages();
}
