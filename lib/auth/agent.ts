import { query } from "@/lib/db/pool";
import { CrmError } from "@/lib/crm/errors";
import { isScope, type Scope } from "@/lib/crm/scopes";
import { hashToken } from "@/lib/crm/tokens";
import type { AgentActor } from "@/lib/crm/types";

type AgentRow = {
  agent_id: string;
  workspace_id: string;
  credential_id: string;
  agent_name: string;
  scopes: string[];
  enabled: boolean;
};

export async function authenticateAgent(request: Request): Promise<AgentActor> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) {
    throw new CrmError("unauthorized", "Missing bearer token.", 401);
  }

  const result = await query<AgentRow>(
    "select * from private.authenticate_agent($1)",
    [hashToken(match[1])],
  );
  const row = result.rows[0];
  if (!row || !row.enabled) {
    throw new CrmError("unauthorized", "Invalid credentials.", 401);
  }

  await query("select private.touch_agent_credential($1)", [row.credential_id]);

  const scopes = row.scopes.filter(isScope);
  return {
    type: "agent",
    agentId: row.agent_id,
    agentName: row.agent_name,
    credentialId: row.credential_id,
    workspaceId: row.workspace_id,
    scopes: scopes as Scope[],
  };
}

export async function consumeRateLimit(actor: AgentActor) {
  const result = await query<{ allowed: boolean }>(
    "select private.consume_rate_limit($1, $2, $3) as allowed",
    [`agent:${actor.credentialId}`, 120, 60],
  );
  if (!result.rows[0]?.allowed) {
    throw new CrmError("rate_limited", "Too many requests.", 429);
  }
}
