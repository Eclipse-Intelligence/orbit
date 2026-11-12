import { loadEnvFile } from "./load-env";

loadEnvFile(".env.local");

function arg(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const dryRun = process.argv.includes("--dry-run");
const onlyWorkspace = arg("--workspace");

async function main() {
  if (process.argv.includes("--workspace") && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(onlyWorkspace ?? "")) {
    console.error("Give --workspace a workspace id, for example --workspace 2b1c9e4a-0000-4000-8000-000000000000.");
    process.exit(1);
  }
  const { getAdminPool, getPool } = await import("@/lib/db/pool");
  const { actorFor } = await import("@/lib/companion/pairing");
  const { backfillTaskLinks } = await import("@/lib/crm/task-links");

  const admin = getAdminPool();
  const owners = await admin.query<{ workspace_id: string; name: string; user_id: string }>(
    `select distinct on (w.id) w.id as workspace_id, w.name, m.user_id
     from crm.workspaces w
     join crm.workspace_members m on m.workspace_id = w.id and m.role = 'owner'
     where $1::uuid is null or w.id = $1::uuid
     order by w.id, m.created_at`,
    [onlyWorkspace ?? null],
  );
  if (owners.rows.length === 0) {
    console.error(onlyWorkspace ? "No workspace with that id has an owner." : "No workspaces have an owner.");
    process.exitCode = 1;
  }
  for (const owner of owners.rows) {
    const actor = await actorFor(owner.user_id, owner.workspace_id);
    if (!actor) {
      console.error(`Skipped ${owner.name}: its owner couldn't be loaded.`);
      continue;
    }
    const result = await backfillTaskLinks(actor, { dryRun });
    console.log(`${owner.name}: checked ${result.checked} open unlinked tasks, ${dryRun ? "would link" : "linked"} ${result.linked}, failed ${result.failed}.`);
    for (const task of result.tasks) console.log(`  ${task.id} ${task.title} -> ${JSON.stringify(task.links)}`);
  }
  await admin.end();
  await getPool().end();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
