import { loadEnvFile } from "./load-env";

loadEnvFile(".env.local");

function arg(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const name = arg("--name") ?? "Agent";
const description = arg("--description") ?? null;
const scopes = (arg("--scopes") ?? "crm:read,companies:write")
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean);
const workspaceId = arg("--workspace");

async function main() {
const { getAdminPool } = await import("@/lib/db/pool");
const { generateAgentToken } = await import("@/lib/crm/tokens");
const { SCOPES, isScope } = await import("@/lib/crm/scopes");

const unknown = scopes.filter((scope) => !isScope(scope));
if (scopes.length === 0 || unknown.length > 0) {
  console.error(`Scopes must be chosen from: ${SCOPES.join(", ")}`);
  process.exit(1);
}

const admin = getAdminPool();
const workspace = workspaceId
  ? { rows: [{ id: workspaceId }] }
  : await admin.query<{ id: string }>(
      "select id from crm.workspaces order by created_at limit 1",
    );

if (!workspace.rows[0]?.id) {
  console.error("No workspace exists yet. Sign in once, then create an agent.");
  process.exit(1);
}

const issued = generateAgentToken();
const agent = await admin.query<{ id: string }>(
  `insert into crm.agents (workspace_id, name, description, scopes)
   values ($1, $2, $3, $4)
   returning id`,
  [workspace.rows[0].id, name, description, scopes],
);
await admin.query(
  `insert into crm.agent_credentials (agent_id, token_prefix, token_hash)
   values ($1, $2, $3)`,
  [agent.rows[0].id, issued.prefix, issued.hash],
);

console.log(`Agent ${agent.rows[0].id}`);
console.log(`Token (shown once): ${issued.token}`);
await admin.end();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
