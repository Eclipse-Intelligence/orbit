import type { DocsData, DocsSeed, RecordRef } from "@/lib/docs/client-types";
import { createFakeDocs } from "@/lib/docs/fake-adapter";

let instance: DocsData | null = null;

export function connectDocs(seed: DocsSeed, options: { recordSearch?: (query: string) => Promise<RecordRef[]> } = {}) {
  if (!instance) instance = createFakeDocs({ ...seed, recordSearch: options.recordSearch });
  return instance;
}

export function docsData() {
  if (!instance) throw new Error("Docs is still loading. Try again in a moment.");
  return instance;
}

export function docsConnected() {
  return instance !== null;
}
