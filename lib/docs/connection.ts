import type { DocsData, RecordRef } from "@/lib/docs/client-types";
import { createLiveDocs, type LiveOptions } from "@/lib/docs/live-adapter";

type Options = { recordSearch?: (query: string) => Promise<RecordRef[]>; live?: LiveOptions | null };
type Connection = DocsData & { refreshActivity?: () => Promise<void> };

let instance: Connection | null = null;
let pending: Options | null = null;
let supplied = false;

export function connectDocs(options: Options = {}, data?: Connection) {
  if (data) {
    instance = data;
    supplied = true;
    return;
  }
  if (!instance && !pending) pending = options;
}

export function resetDocsConnection() {
  if (!supplied) instance = null;
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
