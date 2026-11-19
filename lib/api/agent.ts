import { authenticateAgent, consumeRateLimit } from "@/lib/auth/agent";
import { authenticatePersonal, consumePersonalRateLimit, isPersonalToken } from "@/lib/auth/personal";
import type { Actor } from "@/lib/crm/types";

export async function requireAgent(request: Request) {
  const actor = await authenticateAgent(request);
  await consumeRateLimit(actor);
  return actor;
}

export async function requireCaller(request: Request): Promise<Actor> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!isPersonalToken(bearer)) return requireAgent(request);
  const personal = await authenticatePersonal(bearer);
  await consumePersonalRateLimit(personal.tokenId);
  return personal.actor;
}
