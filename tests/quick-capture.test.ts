import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPersonalToken } from "@/lib/auth/personal";
import { getPool } from "@/lib/db/pool";
import { CrmError } from "@/lib/crm/errors";
import { listTasks } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getDailyNote } from "@/lib/docs/daily-notes";
import { quickCapture, readQuickCapture } from "@/lib/quick-capture";
import { POST } from "@/app/api/quick/route";
import { createUser, resetDatabase } from "./helpers";

let owner: UserActor;
let token: string;

before(async () => {
  await resetDatabase();
  owner = await createUser("quick@orbit-quick.test", "Quick Owner");
  token = (await createPersonalToken(owner, "iPhone Shortcut")).token;
});

after(async () => {
  await getPool().end();
});

function request(body: unknown, auth = `Bearer ${token}`, type = "application/json") {
  return new Request("http://localhost/api/quick", {
    method: "POST",
    headers: { authorization: auth, "content-type": type },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("quick capture from an iPhone Shortcut", () => {
  it("reads where the text goes, defaulting to the daily note", () => {
    assert.deepEqual(readQuickCapture({ text: "  Call Sam  " }), { to: "daily", text: "Call Sam" });
    assert.deepEqual(readQuickCapture({ text: "Call Sam", to: "Task" }), { to: "task", text: "Call Sam" });
    assert.deepEqual(readQuickCapture("Plain text body"), { to: "daily", text: "Plain text body" });
    assert.throws(() => readQuickCapture({ text: " " }), (error) => error instanceof CrmError && /Nothing to add/.test(error.message));
    assert.throws(() => readQuickCapture({ text: "x", to: "calendar" }), (error) => error instanceof CrmError && /"daily" or "task"/.test(error.message));
  });

  it("adds to today's daily note and makes tasks for the token's owner", async () => {
    const now = new Date("2026-10-30T08:20:00Z");
    assert.equal(await quickCapture(request({}), { to: "daily", text: "Scary movies for the weekend" }, now), "Added to today's note at 08:20.");
    const note = await getDailyNote(owner, "2026-10-30");
    assert.match(note?.page.content ?? "", /^08:20 Scary movies for the weekend$/m);
    assert.equal(await quickCapture(request({}), { to: "task", text: "Send the proposal\nInclude the pilot pricing" }), "Added a task: Send the proposal");
    const tasks = await listTasks(owner, { mine: true });
    const task = tasks.data.find((item) => item.title === "Send the proposal");
    assert.equal(task?.description, "Include the pilot pricing");
  });

  it("answers in plain text, and refuses requests without a personal token", async () => {
    const added = await POST(request({ text: "From the route", to: "daily" }));
    assert.equal(added.status, 200);
    assert.match(await added.text(), /^Added to today's note at \d{2}:\d{2}\.$/);
    const missing = await POST(request({ text: "Hi" }, ""));
    assert.equal(missing.status, 401);
    assert.match(await missing.text(), /personal token/);
    const wrong = await POST(request({ text: "Hi" }, "Bearer orbit_nope_nope"));
    assert.equal(wrong.status, 401);
    const empty = await POST(request("", `Bearer ${token}`, "text/plain"));
    assert.equal(empty.status, 400);
  });
});
