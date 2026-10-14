import { revalidatePath } from "next/cache";

export function revalidateRecordPages() {
  revalidatePath("/(crm)/companies/[id]", "page");
  revalidatePath("/(crm)/contacts/[id]", "page");
}
