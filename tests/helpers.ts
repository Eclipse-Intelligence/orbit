import { readFileSync } from "node:fs";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { scopesForRole, type Scope } from "@/lib/crm/scopes";
import { generateAgentToken } from "@/lib/crm/tokens";
import type { AgentActor, UserActor } from "@/lib/crm/types";

export async function resetDatabase() {
  const admin = getAdminPool();
  await admin.query(`
    drop trigger if exists on_auth_user_created on auth.users;
    drop schema if exists crm cascade;
    drop schema if exists private cascade;
    drop schema if exists public cascade;
    create schema public;
    grant all on schema public to postgres;
    grant usage on schema public to public;
  `);
  await admin.query(readFileSync("supabase/bootstrap/local-auth.sql", "utf8"));
  await admin.query("truncate auth.users cascade");
  await admin.query(
    readFileSync("supabase/migrations/20261005140000_crm_foundation.sql", "utf8"),
  );
}

export async function createUser(email: string, name = "Test User") {
  const admin = getAdminPool();
  const user = await admin.query<{ id: string }>(
    "select private.create_local_user($1, $2, $3) as id",
    [email, "password-123", name],
  );
  const userId = user.rows[0].id;
  const workspace = await admin.query<{ id: string }>(
    "select private.ensure_personal_workspace($1) as id",
    [userId],
  );
  const actor: UserActor = {
    type: "user",
    userId,
    email,
    fullName: name,
    workspaceId: workspace.rows[0].id,
    workspaceName: "My workspace",
    role: "owner",
    scopes: scopesForRole("owner"),
  };
  return actor;
}

export async function createAgent(workspaceId: string, scopes: Scope[], name = "Test agent") {
  const admin = getAdminPool();
  const issued = generateAgentToken();
  const agent = await admin.query<{ id: string }>(
    "insert into crm.agents (workspace_id, name, scopes) values ($1, $2, $3) returning id",
    [workspaceId, name, scopes],
  );
  const credential = await admin.query<{ id: string }>(
    `insert into crm.agent_credentials (agent_id, token_prefix, token_hash)
     values ($1, $2, $3) returning id`,
    [agent.rows[0].id, issued.prefix, issued.hash],
  );
  const actor: AgentActor = {
    type: "agent",
    agentId: agent.rows[0].id,
    agentName: name,
    credentialId: credential.rows[0].id,
    workspaceId,
    scopes,
  };
  return { actor, token: issued.token };
}

export async function asUser<T>(userId: string, run: () => Promise<T>) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    await client.query("set local role authenticated");
    const result = await run();
    await client.query("rollback");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Ignore a rollback failure after the connection is already aborted.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function queryAsUser<T extends Record<string, unknown>>(
  userId: string,
  text: string,
  values: unknown[] = [],
) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    await client.query("set local role authenticated");
    const result = await client.query<T>(text, values);
    return result.rows;
  } finally {
    try {
      await client.query("rollback");
    } catch {
      // The statement may have aborted the transaction already.
    }
    client.release();
  }
}
