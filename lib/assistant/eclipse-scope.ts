import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { eclipseClients, eclipseMcpConfigured, nameKey, sameName, type EclipseClient, type EclipseScope } from "@/lib/eclipse-mcp";

export const ECLIPSE_SCOPED_TOOLS: ReadonlySet<string> = new Set(["eclipse_guide", "eclipse_tools", "eclipse_read", "eclipse_action"]);

export const ECLIPSE_UNAVAILABLE = "Eclipse isn't available in this workspace.";

const LINK_WAIT_MS = 10_000;

type BrandLink = { eclipse_tools: boolean; eclipse_client_id: string | null; eclipse_backfill: boolean };

async function brandLink(actor: UserActor): Promise<BrandLink> {
  return withActor(actor, async (db) => {
    const result = await db.query<BrandLink>(
      "select eclipse_tools, eclipse_client_id, eclipse_backfill from crm.workspace_brands where workspace_id = $1",
      [actor.workspaceId],
    );
    return result.rows[0] ?? { eclipse_tools: false, eclipse_client_id: null, eclipse_backfill: false };
  });
}

function onlyMatch(clients: EclipseClient[], name: string) {
  const matches = clients.filter((client) => sameName(client.name, name));
  return matches.length === 1 ? matches[0] : null;
}

async function linkClient(workspaceId: string, clientId: string, creatorId: string | null) {
  const result = await query<{ linked: boolean }>("select private.link_eclipse_client($1, $2, $3) as linked", [workspaceId, clientId, creatorId]);
  return result.rows[0]?.linked === true;
}

async function backfilledClient(actor: UserActor, clients: EclipseClient[]) {
  const match = onlyMatch(clients, actor.workspaceName);
  if (!match) return null;
  return (await linkClient(actor.workspaceId, String(match.id), null)) ? String(match.id) : null;
}

export async function eclipseScopeFor(actor: UserActor, options: { fetchImpl?: typeof fetch } = {}): Promise<EclipseScope | null> {
  if (!eclipseMcpConfigured()) return null;
  const [link, clients] = await Promise.all([brandLink(actor), eclipseClients(options)]);
  const linked = link.eclipse_client_id ?? (link.eclipse_backfill ? await backfilledClient(actor, clients) : null);
  if (!linked) return null;
  const own = clients.find((client) => String(client.id) === linked);
  if (!own) return null;
  const known = new Map(clients.map((client) => [String(client.id), client.id]));
  if (!link.eclipse_tools) return { clientId: own.id, only: true, refused: new Set(), refusedNames: new Set(), known };
  const others = (await query<{ eclipse_client_id: string | null }>("select eclipse_client_id from private.other_eclipse_workspaces($1)", [actor.workspaceId])).rows;
  const linkedElsewhere = new Set(others.map((row) => row.eclipse_client_id).filter((id): id is string => Boolean(id)));
  const refused = new Set(clients.map((client) => String(client.id)).filter((id) => id !== linked && linkedElsewhere.has(id)));
  const refusedNames = new Set(clients.filter((client) => refused.has(String(client.id))).map((client) => nameKey(client.name)));
  return { clientId: own.id, only: false, refused, refusedNames, known };
}

export async function linkCreatedWorkspace(creatorId: string, workspaceId: string, name: string, options: { fetchImpl?: typeof fetch } = {}) {
  if (!eclipseMcpConfigured()) return false;
  const owns = await query<{ owns: boolean }>("select private.owns_eclipse_brand($1) as owns", [creatorId]);
  if (!owns.rows[0]?.owns) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LINK_WAIT_MS);
  });
  try {
    const clients = await Promise.race([eclipseClients(options).catch(() => null), late]);
    const match = clients ? onlyMatch(clients, name) : null;
    return match ? linkClient(workspaceId, String(match.id), creatorId) : false;
  } finally {
    clearTimeout(timer);
  }
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
