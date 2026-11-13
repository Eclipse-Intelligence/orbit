import { getUserActor } from "@/lib/auth/user";
import { prepareTaskRequest } from "@/lib/crm/task-prepare";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const user = await getUserActor();
  const input = await request.json().catch(() => ({}));
  const result = await prepareTaskRequest(user, input);
  return Response.json(result.body, { status: result.status, headers: { "cache-control": "private, no-store" } });
}
