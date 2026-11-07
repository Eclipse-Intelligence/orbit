import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { signInCredentials } from "@/lib/auth/credentials";
import { verifyLocalPassword } from "@/lib/auth/user";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { resetDatabase } from "./helpers";

before(async () => {
  await resetDatabase();
});

after(async () => {
  await getPool().end();
});

function form(email: string, password: string) {
  const data = new FormData();
  data.set("email", email);
  data.set("password", password);
  return data;
}

describe("passwords with spaces", () => {
  it("trims the email but keeps the password exactly as typed", () => {
    assert.deepEqual(signInCredentials(form("  sam@spaces.test ", "  open sesame  ")), {
      email: "sam@spaces.test",
      password: "  open sesame  ",
    });
    assert.deepEqual(signInCredentials(new FormData()), { email: "", password: "" });
  });

  it("signs in with a password that starts and ends with spaces", async () => {
    const created = await getAdminPool().query<{ id: string }>("select private.create_local_user($1, $2, $3) as id", [
      "sam@spaces.test",
      "  open sesame  ",
      "Sam Spaces",
    ]);
    const { email, password } = signInCredentials(form(" sam@spaces.test", "  open sesame  "));
    assert.equal(await verifyLocalPassword(email, password), created.rows[0].id);
    assert.equal(await verifyLocalPassword(email, password.trim()), null);
  });
});
