import { AsyncLocalStorage } from "node:async_hooks";

export const ASSISTANT_SOURCES = ["assistant", "email"] as const;
export type AssistantSource = (typeof ASSISTANT_SOURCES)[number];

const current = new AsyncLocalStorage<AssistantSource>();

export function withToolSource<T>(source: AssistantSource | undefined, run: () => T): T {
  return source ? current.run(source, run) : run();
}

export function toolSource(): AssistantSource {
  return current.getStore() ?? "assistant";
}

export function isAssistantSource(source: string | null | undefined) {
  return ASSISTANT_SOURCES.includes(source as AssistantSource);
}
