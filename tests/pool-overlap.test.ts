import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { appTransaction, getAdminPool, query } from "@/lib/db/pool";
import { resetDatabase, takeOverlappingQueries, useServerlessPool } from "./helpers";

describe("overlapping query guard", () => {
  before(async () => {
    await resetDatabase();
  });

  after(async () => {
    await getAdminPool().end();
  });

  useServerlessPool();

  test("queries awaited in order on one client pass", async () => {
    const values = await appTransaction(async (db) => {
      const first = await db.query<{ value: number }>("select 1 as value");
      const second = await db.query<{ value: number }>("select 2 as value");
      return [first.rows[0].value, second.rows[0].value];
    });
    assert.deepEqual(values, [1, 2]);
    assert.deepEqual(takeOverlappingQueries(), []);
  });

  test("parallel queries on one client are caught", async () => {
    await appTransaction(async (db) => {
      await Promise.all([db.query("select pg_sleep(0.05)"), db.query("select 1")]);
    });
    const overlaps = takeOverlappingQueries();
    assert.equal(overlaps.length, 1);
    assert.match(overlaps[0], /pool-overlap\.test\.ts/);
  });

  test("an overlap is caught even when its error is swallowed", async () => {
    await appTransaction(async (db) => {
      try {
        await Promise.all([db.query("select pg_sleep(0.05)"), db.query("select 1 / 0")]);
      } catch {}
    }).catch(() => undefined);
    assert.ok(takeOverlappingQueries().length >= 1);
  });

  test("parallel queries on separate pool clients pass", async () => {
    const results = await Promise.all([query<{ value: number }>("select 1 as value"), query<{ value: number }>("select 2 as value")]);
    assert.deepEqual(results.map((result) => result.rows[0].value), [1, 2]);
    assert.deepEqual(takeOverlappingQueries(), []);
  });
});
