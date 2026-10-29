import type { DocsData, RecordRef } from "@/lib/docs/client-types";
import { createLiveDocs } from "@/lib/docs/live-adapter";

type Options = { recordSearch?: (query: string) => Promise<RecordRef[]> };

let instance: (DocsData & { refreshActivity?: () => Promise<void> }) | null = null;
let pending: Options | null = null;

export function connectDocs(options: Options = {}) {
  if (!instance && !pending) pending = options;
}

export function docsData() {
  if (!instance && pending) instance = createLiveDocs(pending);
  if (!instance) throw new Error("Docs is still loading. Try again in a moment.");
  return instance;
}

export function docsConnected() {
  return instance !== null || pending !== null;
}

export function refreshDocsActivity() {
  if (instance?.refreshActivity) void instance.refreshActivity();
}
