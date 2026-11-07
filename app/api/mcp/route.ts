import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateAgent, consumeRateLimit } from "@/lib/auth/agent";
import { authenticatePersonal, consumePersonalRateLimit, isPersonalToken } from "@/lib/auth/personal";
import { errorResponse } from "@/lib/api/http";
import { jsonRpcError, rateLimitedResponse, readMcpBody } from "@/lib/api/mcp-request";
import { CrmError } from "@/lib/crm/errors";
import { moveTargets } from "@/lib/crm/move-workspace";
import { createCrmMcpServer } from "@/server/mcp/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    const personal = isPersonalToken(bearer) ? await authenticatePersonal(bearer) : null;
    const agent = personal ? null : await authenticateAgent(request);
    const read = await readMcpBody(request);
    const cost = read.ok ? read.cost : 1;
    try {
      if (personal) await consumePersonalRateLimit(personal.tokenId, cost);
      else if (agent) await consumeRateLimit(agent, cost);
    } catch (error) {
      if (error instanceof CrmError && error.code === "rate_limited") return rateLimitedResponse(cost, read.ok ? read.id : null);
      throw error;
    }
    if (!read.ok) return jsonRpcError(read.status, read.code, read.message);
    const actor = personal?.actor ?? agent!;
    const server = createCrmMcpServer(actor, { workspaces: await moveTargets(actor) });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request, { parsedBody: read.body });
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
