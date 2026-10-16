import { decideAction, sendMessage, type AssistantEvent } from "@/lib/assistant/chat";
import { AssistantError, gatewayConfigured } from "@/lib/assistant/gateway";
import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { query } from "@/lib/db/pool";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BUDGET_MS = 285_000;

async function allowed(userId: string) {
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [
    `assistant:${userId}`,
    60,
    600,
  ]);
  return Boolean(result.rows[0]?.allowed);
}

export async function POST(request: Request) {
  const started = Date.now();
  const actor = await getUserActor();
  if (!actor) return Response.json({ error: "Sign in again." }, { status: 401 });
  if (!gatewayConfigured()) return Response.json({ error: "Set LLM_API_KEY in Vercel to use the assistant." }, { status: 503 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "That request could not be read." }, { status: 400 });
  }
  if (!(await allowed(actor.userId))) {
    return Response.json({ error: "That's a lot of questions in a short time. Wait a few minutes." }, { status: 429 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: AssistantEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      const options = { deadline: started + BUDGET_MS };
      try {
        if (typeof body.actionId === "string" && typeof body.conversationId === "string") {
          await decideAction(
            actor,
            { conversationId: body.conversationId, actionId: body.actionId, approve: body.approve === true },
            emit,
            options,
          );
        } else {
          await sendMessage(
            actor,
            {
              conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
              message: typeof body.message === "string" ? body.message : "",
              model: body.model,
              reasoning: body.reasoning,
              webSearch: body.webSearch,
            },
            emit,
            options,
          );
        }
      } catch (error) {
        const message =
          error instanceof AssistantError || error instanceof CrmError ? error.message : "Something went wrong. Try again.";
        if (!(error instanceof AssistantError || error instanceof CrmError)) console.error("Assistant failed", error);
        emit({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
