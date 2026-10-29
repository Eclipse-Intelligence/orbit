import { requireAgent } from "@/lib/api/agent";
import { withApi } from "@/lib/api/http";
import { listFolders } from "@/lib/docs/folders";

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await requireAgent(request);
    return Response.json({ folders: await listFolders(actor) });
  });
}
