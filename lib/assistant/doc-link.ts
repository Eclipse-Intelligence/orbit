import { isUuid } from "@/lib/crm/mutate";
import { withoutMarkers } from "@/lib/assistant/untrusted";

const OPENS_IN_DOCS = new Set(["replace", "append", "edit", "tag", "rename"]);

export function docLinkOf(name: string, given: Record<string, unknown>): { docId?: string } {
  if (name !== "save_doc") return {};
  const args = withoutMarkers(given);
  const action = typeof args.action === "string" ? args.action : "";
  const docId = typeof args.docId === "string" ? args.docId.trim() : "";
  return OPENS_IN_DOCS.has(action) && isUuid(docId) ? { docId } : {};
}
