export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export type AssistantModel = {
  id: string;
  label: string;
  maker: string;
  reasoning: readonly ReasoningLevel[];
};

export const ASSISTANT_MODELS: AssistantModel[] = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", maker: "Anthropic", reasoning: REASONING_LEVELS },
  { id: "claude-opus-5-5", label: "Opus 5.5", maker: "Anthropic", reasoning: REASONING_LEVELS },
  { id: "gpt-6-astra", label: "GPT-6 Astra", maker: "OpenAI", reasoning: REASONING_LEVELS },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", maker: "OpenAI", reasoning: REASONING_LEVELS },
  { id: "grok-4.7", label: "Grok 4.7", maker: "xAI", reasoning: ["low", "medium", "high", "xhigh"] },
  { id: "gemini-4-argon", label: "Gemini 4 Argon", maker: "Google", reasoning: ["low", "medium", "high"] },
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

export function settingsFor(model: unknown, reasoning: unknown) {
  const chosen = assistantModel(model) ?? assistantModel(DEFAULT_MODEL)!;
  const wanted = REASONING_LEVELS.indexOf(reasoning as ReasoningLevel);
  if (wanted < 0) {
    const level = chosen.reasoning.includes(DEFAULT_REASONING) ? DEFAULT_REASONING : chosen.reasoning[0];
    return { model: chosen.id, reasoning: level };
  }
  const level =
    [...chosen.reasoning].reverse().find((option) => REASONING_LEVELS.indexOf(option) <= wanted) ?? chosen.reasoning[0];
  return { model: chosen.id, reasoning: level };
}
