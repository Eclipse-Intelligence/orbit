import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { acceptInvite, createInvite, previewInvite, removeMember, setMemberRole } from "@/lib/crm/team";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

async function localUser(email: string, name: string) {
  const created = await getAdminPool().query<{ id: string }>("select private.create_local_user($1, $2, $3) as id", [
    email,
    "password-123",
    name,
  ]);
  return created.rows[0].id;
}

async function join(owner: UserActor, email: string, name: string, role: WorkspaceRole): Promise<UserActor> {
  const userId = await localUser(email, name);
  await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [
    owner.workspaceId,
    userId,
    role,
  ]);
  return { ...owner, userId, email, fullName: name, role, scopes: scopesForRole(role) };
}

describe("invites from people who lose access", () => {
  let owner: UserActor;

  before(async () => {
    await resetDatabase();
    owner = await createUser("owner@invites-review.test", "Olive Owner");
  });

  after(async () => {
    await getPool().end();
  });

  it("revokes every pending invite an admin sent when they are removed", async () => {
    const admin = await join(owner, "ada@invites-review.test", "Ada Admin", "admin");
    const invite = await createInvite(admin, { email: "ada.backup@invites-review.test" });
    const other = await createInvite(admin, { email: "friend@invites-review.test" });
    const ownerInvite = await createInvite(owner, { email: "kept@invites-review.test" });
    await removeMember(owner, admin.userId);

    assert.equal((await previewInvite(invite.token))?.status, "revoked");
    assert.equal((await previewInvite(other.token))?.status, "revoked");
    assert.equal((await previewInvite(ownerInvite.token))?.status, "pending");
    const backup = await localUser("ada.backup@invites-review.test", "Ada Backup");
    await assert.rejects(acceptInvite(invite.token, backup), /no longer valid/);
    const member = await getAdminPool().query("select 1 from crm.workspace_members where workspace_id = $1 and user_id = $2", [
      owner.workspaceId,
      backup,
    ]);
    assert.equal(member.rowCount, 0);
  });

  it("refuses an invite whose sender is no longer an owner or admin", async () => {
    const admin = await join(owner, "dan@invites-review.test", "Dan Demoted", "admin");
    const invite = await createInvite(admin, { email: "dan.friend@invites-review.test" });
    await setMemberRole(owner, admin.userId, "member");
    assert.equal((await previewInvite(invite.token))?.status, "revoked");
    const friend = await localUser("dan.friend@invites-review.test", "Dan Friend");
    await assert.rejects(acceptInvite(invite.token, friend), /no longer valid/);

    const later = await join(owner, "lee@invites-review.test", "Lee Later", "admin");
    const stale = await createInvite(later, { email: "lee.friend@invites-review.test" });
    await getAdminPool().query("alter table crm.workspace_members disable trigger workspace_members_revoke_invites");
    try {
      await getAdminPool().query("update crm.workspace_members set role = 'member' where workspace_id = $1 and user_id = $2", [
        owner.workspaceId,
        later.userId,
      ]);
    } finally {
      await getAdminPool().query("alter table crm.workspace_members enable trigger workspace_members_revoke_invites");
    }
    const leeFriend = await localUser("lee.friend@invites-review.test", "Lee Friend");
    await assert.rejects(acceptInvite(stale.token, leeFriend), /no longer valid/);
    assert.equal((await previewInvite(stale.token))?.status, "revoked");
  });

  it("keeps one live invite per address when several are sent at once", async () => {
    const sent = await Promise.all(
      Array.from({ length: 6 }, () => createInvite(owner, { email: "Busy@Invites-Review.test" })),
    );
    const pending = await getAdminPool().query<{ id: string }>(
      `select id from crm.workspace_invites
       where workspace_id = $1 and lower(email) = 'busy@invites-review.test' and accepted_at is null and revoked_at is null`,
      [owner.workspaceId],
    );
    assert.equal(pending.rowCount, 1);
    const live = sent.filter((invite) => invite.inviteId === pending.rows[0].id);
    assert.equal(live.length, 1);
    const busy = await localUser("busy@invites-review.test", "Busy Person");
    for (const invite of sent.filter((item) => item !== live[0])) {
      await assert.rejects(acceptInvite(invite.token, busy), /no longer valid/);
    }
    assert.equal(await acceptInvite(live[0].token, busy), owner.workspaceId);
  });

  it("refuses a second pending invite for the same address at the database", async () => {
    await createInvite(owner, { email: "unique@invites-review.test" });
    await assert.rejects(
      getAdminPool().query(
        "insert into crm.workspace_invites (workspace_id, email, role, token_hash, invited_by) values ($1, 'UNIQUE@invites-review.test', 'member', 'manual-hash', $2)",
        [owner.workspaceId, owner.userId],
      ),
      /workspace_invites_one_pending_idx/,
    );
  });
});
