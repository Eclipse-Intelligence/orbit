import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateAgent, consumeRateLimit } from "@/lib/auth/agent";
import { errorResponse } from "@/lib/api/http";
import { createCrmMcpServer } from "@/server/mcp/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const actor = await authenticateAgent(request);
    await consumeRateLimit(actor);
    const server = createCrmMcpServer(actor);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  } catch (error) {
    return errorResponse(error);
  }
}

export function GET() {
  return Response.json(
    {
      error: {
        code: "method_not_allowed",
        message: "Send MCP JSON-RPC requests with POST.",
      },
    },
    { status: 405, headers: { allow: "POST" } },
  );
}
