import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getAdminPool, getPool } from "@/lib/db/pool";

describe("pool idle timeout", () => {
  const saved = process.env.VERCEL;

  beforeEach(async () => {
    await getPool().end();
  });

  afterEach(async () => {
    await getPool().end();
    if (saved === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = saved;
  });

  it("keeps connections for a minute on Vercel, with two of them", () => {
    process.env.VERCEL = "1";
    const pool = getPool();
    assert.equal(pool.options.idleTimeoutMillis, 60_000);
    assert.equal(pool.options.max, 2);
  });

  it("keeps the short timeout off Vercel so scripts exit promptly", () => {
    delete process.env.VERCEL;
    assert.equal(getPool().options.idleTimeoutMillis, 10_000);
  });

  it("logs a dropped idle connection instead of crashing", async () => {
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      assert.doesNotThrow(() => getPool().emit("error", new Error("Connection terminated unexpectedly")));
      assert.doesNotThrow(() => getAdminPool().emit("error", new Error("Connection terminated unexpectedly")));
    } finally {
      console.error = original;
      await getAdminPool().end();
    }
    assert.deepEqual(logged, [
      ["Database pool connection failed", "Connection terminated unexpectedly"],
      ["Database pool connection failed", "Connection terminated unexpectedly"],
    ]);
  });
});
