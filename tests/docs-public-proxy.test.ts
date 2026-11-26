import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

async function through(path: string) {
  const response = await proxy(new NextRequest(`http://orbit.test${path}`));
  return { status: response.status, location: response.headers.get("location"), next: response.headers.get("x-middleware-next") === "1" };
}

describe("proxy and public docs", () => {
  it("lets a public doc address through without a session", async () => {
    assert.equal((await through("/d/abcdefghijklmnopqrstuvwxyz123456")).next, true);
    assert.equal((await through("/api/d/abcdefghijklmnopqrstuvwxyz123456/pdf")).next, true);
  });

  it("still sends signed-out visitors to sign in for Docs and for a bare /d", async () => {
    for (const path of ["/docs", "/docs/some-id", "/d", "/dx/abc", "/documents"]) {
      const result = await through(path);
      assert.equal(result.next, false, path);
      assert.match(result.location ?? "", /\/login/, path);
    }
  });
});
