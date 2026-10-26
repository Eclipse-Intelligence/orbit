export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export type ModelSource = "orbit" | "chatgpt" | "claude";

type AssistantModel = {
  id: string;
  apiModel: string;
  label: string;
  maker: string;
  source: ModelSource;
  reasoning: readonly ReasoningLevel[];
};

const CODEX_LEVELS: readonly ReasoningLevel[] = ["low", "medium", "high", "xhigh"];

export const MODEL_SOURCES: { id: ModelSource; label: string }[] = [
  { id: "orbit", label: "Orbit" },
  { id: "claude", label: "Claude account" },
  { id: "chatgpt", label: "ChatGPT account" },
];

function orbit(id: string, label: string, maker: string, reasoning: readonly ReasoningLevel[] = REASONING_LEVELS): AssistantModel {
  return { id, apiModel: id, label, maker, source: "orbit", reasoning };
}

function account(source: "chatgpt" | "claude", apiModel: string, label: string, reasoning: readonly ReasoningLevel[]): AssistantModel {
  return { id: `${source}/${apiModel}`, apiModel, label, maker: source === "claude" ? "Anthropic" : "OpenAI", source, reasoning };
}

export const ASSISTANT_MODELS: AssistantModel[] = [
  orbit("claude-sonnet-5-5", "Sonnet 5.5", "Anthropic"),
  orbit("claude-opus-5-5", "Opus 5.5", "Anthropic"),
  orbit("claude-haiku-5-5", "Haiku 5.5", "Anthropic"),
  orbit("gpt-6-astra", "GPT-6 Astra", "OpenAI"),
  orbit("gpt-6.1-sol", "GPT-6.1 Sol", "OpenAI"),
  orbit("grok-4.7", "Grok 4.7", "xAI", ["low", "medium", "high", "xhigh"]),
  orbit("gemini-4-argon", "Gemini 4 Argon", "Google", ["low", "medium", "high"]),
  account("claude", "claude-opus-5-5", "Opus 5.5", REASONING_LEVELS),
  account("claude", "claude-sonnet-5-5", "Sonnet 5.5", REASONING_LEVELS),
  account("claude", "claude-haiku-5-5", "Haiku 5.5", REASONING_LEVELS),
  account("chatgpt", "gpt-6.1-sol", "GPT-6.1 Sol", CODEX_LEVELS),
  account("chatgpt", "gpt-6-astra", "GPT-6 Astra", CODEX_LEVELS),
  account("chatgpt", "gpt-6-luna", "GPT-6 Luna", CODEX_LEVELS),
];

export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_REASONING: ReasoningLevel = "medium";

export const REASONING_LABELS: Record<ReasoningLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function assistantModel(id: unknown) {
  return ASSISTANT_MODELS.find((model) => model.id === id) ?? null;
}

export function availableModels(connected: readonly ModelSource[]) {
  return ASSISTANT_MODELS.filter((model) => model.source === "orbit" || connected.includes(model.source));
}

export function settingsFor(model: unknown, reasoning: unknown, connected?: readonly ModelSource[]) {
  const known = assistantModel(model);
  const usable = known && (!connected || known.source === "orbit" || connected.includes(known.source)) ? known : null;
  const chosen = usable ?? assistantModel(DEFAULT_MODEL)!;
  const wanted = REASONING_LEVELS.indexOf(reasoning as ReasoningLevel);
  if (wanted < 0) {
    const level = chosen.reasoning.includes(DEFAULT_REASONING) ? DEFAULT_REASONING : chosen.reasoning[0];
    return { model: chosen.id, reasoning: level };
  }
  const level =
    [...chosen.reasoning].reverse().find((option) => REASONING_LEVELS.indexOf(option) <= wanted) ?? chosen.reasoning[0];
  return { model: chosen.id, reasoning: level };
}
