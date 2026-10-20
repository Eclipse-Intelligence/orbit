import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateAgent, consumeRateLimit } from "@/lib/auth/agent";
import { authenticatePersonal, consumePersonalRateLimit, isPersonalToken } from "@/lib/auth/personal";
import { errorResponse } from "@/lib/api/http";
import { createCrmMcpServer } from "@/server/mcp/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    const actor = isPersonalToken(bearer)
      ? await authenticatePersonal(bearer).then(async (found) => {
          await consumePersonalRateLimit(found.tokenId);
          return found.actor;
        })
      : await authenticateAgent(request).then(async (found) => {
          await consumeRateLimit(found);
          return found;
        });
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
