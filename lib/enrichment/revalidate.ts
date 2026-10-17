import { revalidatePath } from "next/cache";
import { revalidateRecordPages } from "@/lib/revalidate";

export function revalidateEnriched() {
  revalidatePath("/contacts");
  revalidatePath("/companies");
  revalidateRecordPages();
}
