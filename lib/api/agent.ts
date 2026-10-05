import { authenticateAgent, consumeRateLimit } from "@/lib/auth/agent";

export async function requireAgent(request: Request) {
  const actor = await authenticateAgent(request);
  await consumeRateLimit(actor);
  return actor;
}
