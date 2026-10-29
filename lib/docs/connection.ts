import type { DocsData, DocsSeed, RecordRef } from "@/lib/docs/client-types";
import { createFakeDocs } from "@/lib/docs/fake-adapter";

type Options = { recordSearch?: (query: string) => Promise<RecordRef[]> };

let instance: DocsData | null = null;
let pending: { seed: DocsSeed; options: Options } | null = null;

export function connectDocs(seed: DocsSeed, options: Options = {}) {
  if (!instance && !pending) pending = { seed, options };
}

export function docsData() {
  if (!instance && pending) instance = createFakeDocs({ ...pending.seed, recordSearch: pending.options.recordSearch });
  if (!instance) throw new Error("Docs is still loading. Try again in a moment.");
  return instance;
}

export function docsConnected() {
  return instance !== null || pending !== null;
}
