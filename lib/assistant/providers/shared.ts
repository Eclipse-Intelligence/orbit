import type { ChatMessage } from "@/lib/assistant/gateway";

export type FunctionTool = {
  type: "function";
  function: { name: string; description: string; parameters?: Record<string, unknown> };
};

export type ProviderInput = {
  modelId: string;
  apiModel: string;
  reasoning: string;
  messages: ChatMessage[];
  webSearch: boolean;
  timeoutMs: number;
  tools: FunctionTool[];
  fetchImpl?: typeof fetch;
  onText?: (text: string) => void;
};

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAuthError";
  }
}
