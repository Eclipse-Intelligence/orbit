import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { loadEnvFile, writeEnvFile } from "./load-env";

loadEnvFile(".env.local");

const reset = process.argv.includes("--reset");
const localDatabase = "postgres://crm_app:crm_app_dev@127.0.0.1:5432/crm";
const localAdminDatabase = "postgres://postgres:postgres@127.0.0.1:5432/crm";

process.env.DATABASE_URL ??= localDatabase;
process.env.DATABASE_ADMIN_URL ??= localAdminDatabase;
process.env.APP_SECRET ??= randomBytes(32).toString("hex");
process.env.DEV_USER_EMAIL ??= "founder@example.com";

const generatedPassword = process.env.DEV_USER_PASSWORD
  ? null
  : randomBytes(12).toString("base64url");
process.env.DEV_USER_PASSWORD ??= generatedPassword ?? "";

async function main() {
const { getAdminPool } = await import("@/lib/db/pool");
const { generateAgentToken } = await import("@/lib/crm/tokens");

const admin = getAdminPool();

async function hostedAuth() {
  const result = await admin.query<{ hosted: boolean }>(
    `select exists (
      select 1
      from information_schema.columns
      where table_schema = 'auth'
        and table_name = 'users'
        and column_name = 'instance_id'
    ) as hosted`,
  );
  return result.rows[0]?.hosted ?? false;
}

async function applySql(path: string) {
  await admin.query(readFileSync(path, "utf8"));
}

const hosted = await hostedAuth();
if (reset && hosted) {
  console.error("Refusing to reset a hosted Supabase auth schema.");
  process.exit(1);
}

if (reset && !hosted) {
  await admin.query("drop schema if exists crm cascade");
  await admin.query("drop schema if exists private cascade");
  const users = await admin.query<{ users: string | null }>(
    "select to_regclass('auth.users')::text as users",
  );
  if (users.rows[0]?.users) await admin.query("truncate auth.users cascade");
}

const authUsers = await admin.query<{ users: string | null }>(
  "select to_regclass('auth.users')::text as users",
);
if (!authUsers.rows[0]?.users) {
  if (hosted) {
    console.error("auth.users is missing. This script will not invent a hosted auth schema.");
    process.exit(1);
  }
  await applySql("supabase/bootstrap/local-auth.sql");
}

const companies = await admin.query<{ companies: string | null }>(
  "select to_regclass('crm.companies')::text as companies",
);
if (!companies.rows[0]?.companies) {
  await applySql("supabase/migrations/20261005140000_crm_foundation.sql");
}

const supabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);
let userId: string | null = null;

if (!hosted && !supabaseConfigured) {
  const email = process.env.DEV_USER_EMAIL!.toLowerCase();
  const existing = await admin.query<{ id: string }>(
    "select id from auth.users where lower(email) = $1",
    [email],
  );
  userId = existing.rows[0]?.id ?? null;
  if (!userId) {
    const created = await admin.query<{ id: string }>(
      "select private.create_local_user($1, $2, $3) as id",
      [email, process.env.DEV_USER_PASSWORD, "Founder"],
    );
    userId = created.rows[0].id;
  }
  await admin.query("select private.ensure_personal_workspace($1)", [userId]);
}

let token = process.env.CRM_AGENT_TOKEN;
if (!token && userId) {
  const workspace = await admin.query<{ id: string }>(
    `select workspace_id as id
     from crm.workspace_members
     where user_id = $1
     order by created_at
     limit 1`,
    [userId],
  );
  const workspaceId = workspace.rows[0]?.id;
  if (workspaceId) {
    const issued = generateAgentToken();
    const agent = await admin.query<{ id: string }>(
      `insert into crm.agents (workspace_id, name, description, scopes, created_by_user_id)
       values ($1, 'Local agent', 'Local development agent', $2, $3)
       returning id`,
      [workspaceId, ["crm:read", "companies:write"], userId],
    );
    await admin.query(
      `insert into crm.agent_credentials (agent_id, token_prefix, token_hash)
       values ($1, $2, $3)`,
      [agent.rows[0].id, issued.prefix, issued.hash],
    );
    token = issued.token;
    process.env.CRM_AGENT_TOKEN = token;
  }
}

writeEnvFile(".env.local", {
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
  APP_SECRET: process.env.APP_SECRET,
  DEV_USER_EMAIL: process.env.DEV_USER_EMAIL,
  DEV_USER_PASSWORD: process.env.DEV_USER_PASSWORD,
  CRM_AGENT_TOKEN: token,
});

console.log("Database is ready.");
if (userId) {
  console.log(`Local user: ${process.env.DEV_USER_EMAIL}`);
  if (generatedPassword) console.log("Password written to .env.local as DEV_USER_PASSWORD.");
}
if (token) console.log("Agent token is in .env.local as CRM_AGENT_TOKEN.");
await admin.end();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
