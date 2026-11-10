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
  maxOutput: number;
  responses?: boolean;
  claudeApi?: boolean;
};

const CODEX_LEVELS: readonly ReasoningLevel[] = ["low", "medium", "high", "xhigh"];

export const MODEL_SOURCES: { id: ModelSource; label: string }[] = [
  { id: "orbit", label: "Orbit" },
  { id: "claude", label: "Claude account" },
  { id: "chatgpt", label: "ChatGPT account" },
];

const K = 1_000;

function orbit(
  id: string,
  label: string,
  maker: string,
  options: { reasoning?: readonly ReasoningLevel[]; maxOutput?: number; responses?: boolean; claudeApi?: boolean } = {},
): AssistantModel {
  return {
    id,
    apiModel: id,
    label,
    maker,
    source: "orbit",
    reasoning: options.reasoning ?? REASONING_LEVELS,
    maxOutput: options.maxOutput ?? 128 * K,
    ...(options.responses ? { responses: true } : {}),
    ...(options.claudeApi ? { claudeApi: true } : {}),
  };
}

function account(source: "chatgpt" | "claude", apiModel: string, label: string, reasoning: readonly ReasoningLevel[]): AssistantModel {
  return { id: `${source}/${apiModel}`, apiModel, label, maker: source === "claude" ? "Anthropic" : "OpenAI", source, reasoning, maxOutput: 128 * K };
}

export const ASSISTANT_MODELS: AssistantModel[] = [
  orbit("claude-sonnet-5-5", "Sonnet 5.5", "Anthropic", { claudeApi: true }),
  orbit("claude-opus-5-5", "Opus 5.5", "Anthropic", { claudeApi: true }),
  orbit("claude-haiku-5-5", "Haiku 5.5", "Anthropic", { claudeApi: true }),
  orbit("gpt-6-astra", "GPT-6 Astra", "OpenAI"),
  orbit("gpt-6.1-sol", "GPT-6.1 Sol", "OpenAI"),
  orbit("gpt-6.1-terra", "GPT-6.1 Terra", "OpenAI", { responses: true }),
  orbit("grok-4.7", "Grok 4.7", "xAI", { reasoning: ["low", "medium", "high", "xhigh"] }),
  orbit("gemini-4-argon", "Gemini 4 Argon", "Google", { reasoning: ["low", "medium", "high"], maxOutput: 65_536 }),
  account("claude", "claude-fable-5-2", "Fable 5.2", REASONING_LEVELS),
  account("claude", "claude-fable-5-1", "Fable 5.1", REASONING_LEVELS),
  account("claude", "claude-opus-5-5", "Opus 5.5", REASONING_LEVELS),
  account("claude", "claude-sonnet-5-5", "Sonnet 5.5", REASONING_LEVELS),
  account("claude", "claude-haiku-5-5", "Haiku 5.5", REASONING_LEVELS),
  account("chatgpt", "gpt-6.1-sol", "GPT-6.1 Sol", CODEX_LEVELS),
  account("chatgpt", "gpt-6.1-terra", "GPT-6.1 Terra", CODEX_LEVELS),
  account("chatgpt", "gpt-6-astra", "GPT-6 Astra", CODEX_LEVELS),
  account("chatgpt", "gpt-6-luna", "GPT-6 Luna", CODEX_LEVELS),
];

export const OUTPUT_TOKENS: Record<ReasoningLevel, number> = {
  low: 16 * K,
  medium: 16 * K,
  high: 32 * K,
  xhigh: 64 * K,
  max: 96 * K,
};

export function outputTokens(model: unknown, reasoning: unknown) {
  const wanted = OUTPUT_TOKENS[reasoning as ReasoningLevel] ?? OUTPUT_TOKENS.medium;
  const known = assistantModel(model) ?? ASSISTANT_MODELS.find((entry) => entry.apiModel === model);
  return Math.min(wanted, known?.maxOutput ?? OUTPUT_TOKENS.medium);
}

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

export type ChatSettingsChoice = { model?: unknown; reasoning?: unknown } | null | undefined;

export function modelUsable(model: unknown, connected?: readonly ModelSource[]) {
  const known = assistantModel(model);
  return Boolean(known && (!connected || known.source === "orbit" || connected.includes(known.source)));
}

export function startingSettings(choices: ChatSettingsChoice[], connected?: readonly ModelSource[]) {
  const found = choices.find((choice) => choice && modelUsable(choice.model, connected));
  return found ? settingsFor(found.model, found.reasoning, connected) : settingsFor(DEFAULT_MODEL, DEFAULT_REASONING, connected);
}
