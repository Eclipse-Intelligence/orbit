import { getUserActor } from "@/lib/auth/user";
import { readPadRequest } from "@/lib/crm/task-pad";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const user = await getUserActor();
  const input = await request.json().catch(() => ({}));
  const result = await readPadRequest(user, input);
  return Response.json(result.body, { status: result.status, headers: { "cache-control": "private, no-store" } });
}
