export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type CompanionTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  write: boolean;
};

export type CompanionRequest = {
  model: string;
  effort: Effort;
  webSearch: boolean;
  system: string;
  prompt: string;
  tools: CompanionTool[];
};

export type CompanionJob = { id: string; request: CompanionRequest };

export type CompanionCall = { id: string; name: string; arguments: string };

export type CompanionStep = { text: string; calls: CompanionCall[] };

export type CompanionToolResult = { content: string; isError: boolean };

export type CompanionSource = { url: string; title: string | null };

export type CompanionResult = {
  steps: CompanionStep[];
  results: Record<string, CompanionToolResult>;
  sources: CompanionSource[];
  model: string | null;
  usage: Record<string, unknown> | null;
};

export type PairResponse = { token: string; companionId: string; email: string | null; workspace: string | null };

export const COMPANION_PROTOCOL = 1;
