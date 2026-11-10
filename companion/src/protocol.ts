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

export type CompanionSteer = { id: string; text: string };

export type CompanionSteered = { id: string; step: number };

export const PROPOSED =
  "Proposed. Orbit will show this change to the user for approval. It has not happened yet. Do not call this tool again for the same change. When you have proposed everything, say in one or two sentences what you proposed and stop.";

export type CompanionResult = {
  steps: CompanionStep[];
  results: Record<string, CompanionToolResult>;
  sources: CompanionSource[];
  model: string | null;
  usage: Record<string, unknown> | null;
  steered?: CompanionSteered[];
};

export type PairResponse = { token: string; companionId: string; email: string | null; workspace: string | null };
