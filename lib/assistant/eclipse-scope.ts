import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { eclipseClients, eclipseMcpConfigured, sameName, type EclipseScope } from "@/lib/eclipse-mcp";

export const ECLIPSE_SCOPED_TOOLS: ReadonlySet<string> = new Set(["eclipse_guide", "eclipse_tools", "eclipse_read", "eclipse_action"]);

export const ECLIPSE_UNAVAILABLE = "Eclipse isn't available in this workspace.";

async function ownsEclipseBrand(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ eclipse_tools: boolean }>("select eclipse_tools from crm.workspace_brands where workspace_id = $1", [actor.workspaceId]);
    return result.rows[0]?.eclipse_tools === true;
  });
}

export async function eclipseScopeFor(actor: UserActor, options: { fetchImpl?: typeof fetch } = {}): Promise<EclipseScope | null> {
  if (!eclipseMcpConfigured()) return null;
  const [clients, owner] = await Promise.all([eclipseClients(options), ownsEclipseBrand(actor)]);
  const own = clients.find((client) => sameName(client.name, actor.workspaceName));
  if (!owner) return own ? { clientId: own.id, only: true, refused: new Set() } : null;
  const others = (await query<{ name: string }>("select name from private.other_workspace_names($1) as name", [actor.workspaceId])).rows.map((row) => row.name);
  const refused = new Set(
    clients.filter((client) => client.id !== own?.id && others.some((name) => sameName(client.name, name))).map((client) => String(client.id)),
  );
  return { clientId: own?.id ?? null, only: false, refused };
}

const VISIBLE_WAIT_MS = 8_000;

export async function eclipseAvailable(actor: UserActor, options: { fetchImpl?: typeof fetch } = {}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), VISIBLE_WAIT_MS);
  });
  try {
    return await Promise.race([
      eclipseScopeFor(actor, options)
        .then((scope) => scope !== null)
        .catch(() => false),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
