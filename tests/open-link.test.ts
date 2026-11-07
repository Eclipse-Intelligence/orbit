import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { alertLink } from "@/lib/crm/workspaces";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { linkInWorkspace, openLink, safeOpenTarget, workspaceLink } from "@/lib/open-link";
import { pushToUser, savePushSubscription, type PushSender } from "@/lib/push";
import { notify } from "@/lib/workflows/engine";
import { createUser, resetDatabase } from "./helpers";

const WORKSPACE = "6f1c1b7e-2a4d-4c55-9a3e-0f6f3b1c2d4e";
const COMPANY = "/companies/0b7b6f0e-6a55-4f7e-8d1b-1f2a3b4c5d6e";

describe("open links", () => {
  it("only opens Orbit pages, never another site", () => {
    for (const path of [COMPANY, "/contacts/abc", "/mail?thread=a%7Cb", "/mail?view=scheduled", "/capture", "/calendar", "/tasks", "/workflows?approve=1", "/workflows/1?run=2", "/proposals/1", "/opportunities?deal=1", "/?chat=1", "/"]) {
      assert.equal(safeOpenTarget(path), path, path);
    }
    assert.equal(safeOpenTarget("/mail/../companies/1"), "/companies/1");
    assert.equal(safeOpenTarget("/settings/notifications"), "/settings/notifications");
    for (const path of [
      "https://evil.test/companies/1",
      "//evil.test/companies/1",
      "/\\evil.test",
      "/%2F%2Fevil.test",
      "\\\\evil.test",
      "/ /evil.test",
      "/companies\n/1",
      "javascript:alert(1)",
      "/api/v1/companies",
      "/login?next=https://evil.test",
      "/open?to=/companies/1",
      "/companies/../x",
      "",
      null,
    ]) {
      assert.equal(safeOpenTarget(path), null, String(path));
    }
  });

  it("wraps links only for people in more than one workspace", () => {
    assert.equal(workspaceLink(WORKSPACE, COMPANY, 1), COMPANY);
    assert.equal(workspaceLink(WORKSPACE, COMPANY, 2), `/open?workspace=${WORKSPACE}&to=${encodeURIComponent(COMPANY)}`);
    assert.equal(workspaceLink(WORKSPACE, "https://teams.microsoft.com/l/meetup-join/1", 2), "https://teams.microsoft.com/l/meetup-join/1");
    assert.equal(workspaceLink("not-a-workspace", COMPANY, 2), COMPANY);
  });

  it("opens a link in this workspace in place and switches for another", () => {
    const link = openLink(WORKSPACE, "/mail?thread=a%7Cb");
    assert.deepEqual(linkInWorkspace(link, WORKSPACE), { path: "/mail?thread=a%7Cb", reload: false });
    assert.deepEqual(linkInWorkspace(link, "a0000000-0000-4000-8000-000000000000"), { path: link, reload: true });
    assert.deepEqual(linkInWorkspace(link, undefined), { path: link, reload: true });
    assert.deepEqual(linkInWorkspace(COMPANY, WORKSPACE), { path: COMPANY, reload: false });
    const sneaky = `/open?workspace=${WORKSPACE}&to=${encodeURIComponent("https://evil.test")}`;
    assert.deepEqual(linkInWorkspace(sneaky, WORKSPACE), { path: sneaky, reload: true });
  });
});

describe("alert links across workspaces", () => {
  let solo: UserActor;
  let mark: UserActor;
  let second: UserActor;

  before(async () => {
    process.env.SITE_URL = "https://orbit.test";
    await resetDatabase();
    solo = await createUser("solo@open.test", "Solo");
    mark = await createUser("mark@open.test", "Mark Ridgeon");
    const other = await createUser("brand@open.test", "Brand");
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [other.workspaceId, mark.userId]);
    second = { ...mark, workspaceId: other.workspaceId };
  });

  after(async () => {
    delete process.env.SITE_URL;
    await getPool().end();
    await getAdminPool().end();
  });

  it("keeps plain links for one workspace and opens the alert's workspace for several", async () => {
    assert.equal(await alertLink(solo, COMPANY), COMPANY);
    assert.equal(await alertLink(second, COMPANY), openLink(second.workspaceId, COMPANY));
    assert.equal(await alertLink(second, "https://teams.microsoft.com/l/1"), "https://teams.microsoft.com/l/1");
  });

  it("sends pushes and bell notifications with the switching link", async () => {
    await savePushSubscription(second, { endpoint: "https://web.push.apple.com/mark", keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
    const sent: string[] = [];
    const send: PushSender = async (_subscription, payload) => {
      sent.push((JSON.parse(payload) as { url: string }).url);
    };
    await pushToUser(second, { title: "Orbit", body: "Booked", url: COMPANY }, { send });
    assert.deepEqual(sent, [openLink(second.workspaceId, COMPANY)]);

    await notify(second, second.userId, { title: "Booked", href: COMPANY, source: "mail" });
    await notify(solo, solo.userId, { title: "Booked", href: COMPANY, source: "mail" });
    const rows = await getAdminPool().query<{ user_id: string; href: string }>("select user_id, href from crm.notifications where title = 'Booked'");
    assert.equal(rows.rows.find((row) => row.user_id === mark.userId)?.href, openLink(second.workspaceId, COMPANY));
    assert.equal(rows.rows.find((row) => row.user_id === solo.userId)?.href, COMPANY);
  });
});
