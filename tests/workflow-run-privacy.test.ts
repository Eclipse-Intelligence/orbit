import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { listWaitingOnOthers } from "@/lib/crm/action-needed";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { getRunSteps, listRuns } from "@/lib/workflows/store";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

const DEFINITION = {
  version: 2,
  trigger: { type: "manual", object: "contact" },
  triggerPosition: { x: 0, y: 0 },
  nodes: [{ id: "approval_1", type: "approval", config: { title: "Send the renewal email", details: "" }, position: { x: 0, y: 0 } }],
  edges: [{ source: "trigger", handle: "out", target: "approval_1" }],
};

let owner: UserActor;
let member: UserActor;
let workflowId: string;
let runId: string;

before(async () => {
  await resetDatabase();
  owner = await createUser("owner@run-privacy.test", "Olive Owner");
  const admin = getAdminPool();
  const memberId = (
    await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", [
      "mia@run-privacy.test",
      "Mia Member",
    ])
  ).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [
    owner.workspaceId,
    memberId,
  ]);
  member = { ...owner, userId: memberId, email: "mia@run-privacy.test", fullName: "Mia Member", role: "member", scopes: scopesForRole("member") };
  workflowId = (
    await admin.query<{ id: string }>(
      "insert into crm.workflows (workspace_id, owner_id, name, status, definition) values ($1, $2, 'Renewals', 'active', $3::jsonb) returning id",
      [owner.workspaceId, memberId, JSON.stringify(DEFINITION)],
    )
  ).rows[0].id;
  const state = {
    started: true,
    frames: [],
    at: "approval_1",
    waitingStep: "approval_1",
    approval: { stepId: "approval_1", title: "Send the renewal email", details: "Private body: the discount is 40%" },
    vars: { email: { body: "Private body: the discount is 40%" }, steps: {} },
  };
  runId = (
    await admin.query<{ id: string }>(
      `insert into crm.workflow_runs (workspace_id, workflow_id, owner_id, status, waiting_for, definition, state, updated_at)
       values ($1, $2, $3, 'waiting', 'approval', $4::jsonb, $5::jsonb, now() - interval '30 days') returning id`,
      [owner.workspaceId, workflowId, memberId, JSON.stringify(DEFINITION), JSON.stringify(state)],
    )
  ).rows[0].id;
  await admin.query(
    `insert into crm.workflow_run_steps (workspace_id, run_id, owner_id, step_id, step_type, label, status, input, output)
     values ($1, $2, $3, 'email_1', 'send_email', 'Draft email', 'succeeded', $4::jsonb, $5::jsonb)`,
    [owner.workspaceId, runId, memberId, JSON.stringify({ body: "Private body: the discount is 40%" }), JSON.stringify({ sent: true })],
  );
});

after(async () => {
  await getPool().end();
});

describe("workflow run privacy", () => {
  it("lets the owner of a run read its steps", async () => {
    const detail = await getRunSteps(member, runId);
    assert.equal(detail.steps.length, 1);
    assert.match(JSON.stringify(detail.steps[0].input), /discount/);
    assert.equal((await listRuns(member, workflowId)).length, 1);
  });

  it("hides another member's run details from a workspace owner", async () => {
    await assert.rejects(getRunSteps(owner, runId), (error: unknown) => error instanceof CrmError && error.status === 404);
    assert.deepEqual(await listRuns(owner, workflowId), []);
    assert.deepEqual(await queryAsUser(owner.userId, "select id, state from crm.workflow_runs where id = $1", [runId]), []);
    assert.deepEqual(await queryAsUser(owner.userId, "select input, output from crm.workflow_run_steps where run_id = $1", [runId]), []);
  });

  it("still shows the owner that a colleague's approval is waiting, without its details", async () => {
    const waiting = await listWaitingOnOthers(owner);
    assert.deepEqual(
      waiting.map((item) => [item.id, item.title, item.ownerName]),
      [[runId, "Send the renewal email", "Mia Member"]],
    );
    assert.doesNotMatch(JSON.stringify(waiting), /discount/);
    assert.deepEqual(await listWaitingOnOthers(member), []);
  });
});
