import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { OAuthError } from "@/lib/ai-accounts/oauth";
import { aiAccess } from "@/lib/ai-accounts/store";
import { systemPrompt } from "@/lib/assistant/prompt";
import { claudeErrorDetail, claudeRequest } from "@/lib/assistant/providers/claude";
import type { FunctionTool } from "@/lib/assistant/providers/shared";
import { toolDefinitions } from "@/lib/assistant/tools";
import { getUserActor } from "@/lib/auth/user";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const HELLO = [{ role: "user" as const, content: "Reply with the single word: ok" }];

function variants(): { name: string; params: MessageCreateParamsNonStreaming }[] {
  const base = (model: string) => ({ model, max_tokens: 64, messages: HELLO, betas: ["oauth-2025-04-20"] });
  const tools = (toolDefinitions() as FunctionTool[]).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: { type: "object" as const, ...(tool.function.parameters ?? {}) },
  }));
  return [
    { name: "haiku, minimal", params: base("claude-haiku-5-5") },
    { name: "sonnet, minimal", params: base("claude-sonnet-5-5") },
    { name: "opus, minimal", params: base("claude-opus-5-5") },
    {
      name: "sonnet, adaptive thinking + effort",
      params: { ...base("claude-sonnet-5-5"), max_tokens: 1024, thinking: { type: "adaptive" }, output_config: { effort: "low" } },
    },
    {
      name: "sonnet, server-side fallbacks",
      params: { ...base("claude-sonnet-5-5"), betas: ["oauth-2025-04-20", "server-side-fallback-2026-07-01"], fallbacks: "default" },
    },
    { name: "sonnet, Orbit tools", params: { ...base("claude-sonnet-5-5"), tools } },
  ];
}

async function attempt(client: Anthropic, name: string, params: MessageCreateParamsNonStreaming) {
  const started = Date.now();
  try {
    const message = await client.beta.messages.create(params);
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    return { name, ok: true, stopReason: message.stop_reason, reply: text.slice(0, 80), ms: Date.now() - started };
  } catch (error) {
    if (error instanceof Anthropic.APIError) return { name, ok: false, ...claudeErrorDetail(error), ms: Date.now() - started };
    return { name, ok: false, message: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
  }
}

export async function GET() {
  const actor = await getUserActor();
  if (!actor) return Response.json({ error: "Sign in first." }, { status: 401 });
  let access;
  try {
    access = await aiAccess(actor, "claude");
  } catch (error) {
    return Response.json({ error: error instanceof OAuthError ? error.message : "Could not read the Claude account." });
  }
  const client = new Anthropic({ apiKey: null, authToken: access.token, maxRetries: 0, timeout: 60_000 });
  const results = [];
  for (const variant of variants()) {
    results.push(await attempt(client, variant.name, variant.params));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const full = claudeRequest({
    modelId: "claude/claude-sonnet-5-5",
    apiModel: "claude-sonnet-5-5",
    reasoning: "medium",
    webSearch: false,
    timeoutMs: 60_000,
    tools: toolDefinitions() as FunctionTool[],
    messages: [{ role: "system", content: systemPrompt(actor, { webSearch: false }) }, ...HELLO],
  });
  results.push(await attempt(client, "sonnet, full assistant request", { ...full, max_tokens: 1024 }));
  return Response.json({ checkedAt: new Date().toISOString(), results }, { headers: { "cache-control": "no-store" } });
}
