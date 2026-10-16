import { complete, type ChatMessage } from "@/lib/assistant/gateway";
import { ASSISTANT_MODELS } from "@/lib/assistant/models";
import { toolDefinitions } from "@/lib/assistant/tools";
import { cronAuthorization } from "@/lib/crm/scheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PROBE_TOOL = {
  type: "function",
  function: {
    name: "get_open_task_count",
    description: "Returns how many open tasks the user has.",
    parameters: { type: "object", properties: {} },
  },
};

async function probe(model: string, webSearch: boolean, full: boolean, reasoning: string) {
  const started = Date.now();
  const messages: ChatMessage[] = [
    { role: "system", content: "Use tools to answer. Reply in one short sentence." },
    { role: "user", content: "How many open tasks do I have? Use the tool." },
  ];
  try {
    const tools = full ? [...toolDefinitions(), PROBE_TOOL] : [PROBE_TOOL];
    const first = await complete({ model, reasoning, messages, webSearch, timeoutMs: 90_000, tools });
    const call = first.toolCalls[0];
    if (!call) return { model, webSearch, ok: false, toolCalled: false, reply: first.content.slice(0, 200), ms: Date.now() - started };
    const second = await complete({
      model,
      reasoning,
      webSearch,
      timeoutMs: 90_000,
      tools,
      messages: [
        ...messages,
        { role: "assistant", content: first.content || null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: JSON.stringify({ openTasks: 7 }) },
      ],
    });
    return { model, webSearch, ok: /7|seven/i.test(second.content), toolCalled: true, reply: second.content.slice(0, 200), ms: Date.now() - started };
  } catch (error) {
    return { model, webSearch, ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
  }
}

async function searchProbe(model: string) {
  const started = Date.now();
  try {
    const result = await complete({
      model,
      reasoning: "low",
      webSearch: true,
      timeoutMs: 120_000,
      tools: [PROBE_TOOL],
      messages: [
        { role: "system", content: "Search the web to answer. Reply in one sentence." },
        { role: "user", content: "What does the company at geteclipse.co do? Search the web." },
      ],
    });
    return { model, searched: result.sources.length > 0, sources: result.sources.slice(0, 3), reply: result.content.slice(0, 240), ms: Date.now() - started };
  } catch (error) {
    return { model, searched: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
  }
}

export async function GET(request: Request) {
  const auth = cronAuthorization(request.headers.get("authorization"));
  if (auth !== "ok") return Response.json({ error: "Not allowed." }, { status: auth === "unconfigured" ? 503 : 401 });
  const url = new URL(request.url);
  const only = url.searchParams.get("model");
  const webSearch = url.searchParams.get("web") === "1";
  const models = ASSISTANT_MODELS.filter((model) => !only || model.id === only).map((model) => model.id);
  if (url.searchParams.get("search") === "1") {
    return Response.json({ results: await Promise.all(models.map((model) => searchProbe(model))) });
  }
  const full = url.searchParams.get("full") === "1";
  const reasoning = url.searchParams.get("reasoning") ?? "low";
  const results = await Promise.all(models.map((model) => probe(model, webSearch, full, reasoning)));
  return Response.json({ results });
}
