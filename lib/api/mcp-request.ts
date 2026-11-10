export const MCP_BATCH_LIMIT = 25;
export const MCP_BODY_LIMIT = 4 * 1024 * 1024;
export const MCP_CALLS_PER_MINUTE = 120;

export type McpBody =
  | { ok: true; body: unknown; cost: number; id: string | number | null }
  | { ok: false; status: number; code: number; message: string };

function messageId(message: unknown) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function isToolCall(message: unknown) {
  return Boolean(message && typeof message === "object" && (message as { method?: unknown }).method === "tools/call");
}

export function mcpCost(body: unknown) {
  const messages = Array.isArray(body) ? body : [body];
  return Math.max(1, messages.filter(isToolCall).length);
}

async function readText(request: Request) {
  if (Number(request.headers.get("content-length")) > MCP_BODY_LIMIT) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MCP_BODY_LIMIT) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function readMcpBody(request: Request): Promise<McpBody> {
  const text = await readText(request);
  if (text === null) return { ok: false, status: 413, code: -32000, message: `Send at most ${MCP_BODY_LIMIT} bytes in one request.` };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, code: -32700, message: "Parse error: the request body isn't valid JSON." };
  }
  if (Array.isArray(body) && body.length > MCP_BATCH_LIMIT) {
    return {
      ok: false,
      status: 400,
      code: -32600,
      message: `Send at most ${MCP_BATCH_LIMIT} messages in one batch. This batch had ${body.length}.`,
    };
  }
  return { ok: true, body, cost: mcpCost(body), id: Array.isArray(body) ? null : messageId(body) };
}

export function jsonRpcError(status: number, code: number, message: string, id: string | number | null = null, data?: Record<string, unknown>) {
  return Response.json(
    { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } },
    { status, headers: status === 429 ? { "retry-after": "60" } : undefined },
  );
}

export function rateLimitedResponse(cost: number, id: string | number | null) {
  const needed = cost === 1 ? "" : ` This request needed ${cost}.`;
  return jsonRpcError(
    429,
    -32029,
    `Too many requests (limit ${MCP_CALLS_PER_MINUTE} tool calls a minute, and each call in a batch counts).${needed} Try again in a minute.`,
    id,
    { code: "rate_limited", retryAfterSeconds: 60, cost },
  );
}
