import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach } from "node:test";
import { applyMigrationSql } from "@/lib/db/migration-sql";
import type { Pool } from "pg";
import { getAdminPool, getPool, takeNestedConnections } from "@/lib/db/pool";
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
  const migrations = readdirSync("supabase/migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrations) {
    await applyMigrationSql(admin, readFileSync(`supabase/migrations/${file}`, "utf8"));
  }
  const password = decodeURIComponent(new URL(process.env.DATABASE_URL!).password);
  const statement = await admin.query<{ sql: string }>(
    "select format('alter role crm_app password %L', $1::text) as sql",
    [password],
  );
  await admin.query(statement.rows[0].sql);
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function useServerlessPool() {
  const saved = { vercel: process.env.VERCEL, strict: process.env.ORBIT_STRICT_POOL };
  let serverless: Pool | null = null;
  let nestingAllowed = false;
  before(async () => {
    await getPool().end();
    process.env.VERCEL = "1";
    process.env.ORBIT_STRICT_POOL = "1";
    serverless = getPool();
    if (serverless.options.max !== 2) throw new Error("The serverless pool should hold two connections.");
  });
  beforeEach(() => {
    nestingAllowed = false;
    process.env.ORBIT_STRICT_POOL = "1";
    takeNestedConnections();
  });
  afterEach(() => {
    const nested = takeNestedConnections();
    process.env.ORBIT_STRICT_POOL = "1";
    if (!nestingAllowed) assert.deepEqual(nested, [], "A transaction started a second pool connection.");
  });
  after(async () => {
    if (serverless && !serverless.ending && !serverless.ended) await serverless.end();
    restoreEnv("VERCEL", saved.vercel);
    restoreEnv("ORBIT_STRICT_POOL", saved.strict);
  });
  return {
    allowNestedConnections() {
      nestingAllowed = true;
      process.env.ORBIT_STRICT_POOL = "0";
    },
  };
}

export async function withStrictPool<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.ORBIT_STRICT_POOL;
  takeNestedConnections();
  process.env.ORBIT_STRICT_POOL = "1";
  try {
    const result = await fn();
    assert.deepEqual(takeNestedConnections(), [], "A transaction started a second pool connection.");
    return result;
  } finally {
    restoreEnv("ORBIT_STRICT_POOL", saved);
  }
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

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
}
