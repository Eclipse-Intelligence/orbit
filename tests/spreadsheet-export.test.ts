import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createContact } from "@/lib/crm/contacts";
import { collectForExport, exportContactsCsv } from "@/lib/crm/spreadsheet";
import type { UserActor } from "@/lib/crm/types";
import { EXPORT_ROW_LIMIT, exportNote } from "@/lib/csv";
import { getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

function fakeList(total: number) {
  const asked: { offset: number; limit: number }[] = [];
  const load = async (offset: number, limit: number) => {
    asked.push({ offset, limit });
    const size = Math.max(0, Math.min(limit, total - offset));
    return { data: Array.from({ length: size }, (_, index) => offset + index), total };
  };
  return { load, asked };
}

describe("CSV export paging", () => {
  it("exports every row past the old 5,000 cut-off", async () => {
    const list = fakeList(7_250);
    const result = await collectForExport(list.load);
    assert.equal(result.rows.length, 7_250);
    assert.equal(result.rows[7_249], 7_249);
    assert.equal(result.truncated, false);
    assert.equal(result.total, 7_250);
    assert.equal(exportNote({ exported: result.rows.length, total: result.total, truncated: result.truncated, outOfTime: result.outOfTime }, "contacts"), null);
  });

  it("stops at the ceiling, never asks past the list offset cap, and says what it left out", async () => {
    const list = fakeList(12_345);
    const result = await collectForExport(list.load);
    assert.equal(result.rows.length, EXPORT_ROW_LIMIT);
    assert.equal(result.total, 12_345);
    assert.equal(result.truncated, true);
    assert.ok(list.asked.every((page) => page.offset + page.limit <= EXPORT_ROW_LIMIT && page.offset <= 10_000));
    assert.equal(new Set(result.rows).size, EXPORT_ROW_LIMIT);
    assert.equal(
      exportNote({ exported: result.rows.length, total: result.total, truncated: result.truncated, outOfTime: result.outOfTime }, "contacts"),
      "Exported 10,000 of 12,345 contacts, the limit for one export.",
    );
  });

  it("stops before the deadline and says it ran out of time", async () => {
    const list = fakeList(9_000);
    let clock = 0;
    const result = await collectForExport(
      async (offset, limit) => {
        clock += 1_000;
        return list.load(offset, limit);
      },
      { budgetMs: 5_000, now: () => clock },
    );
    assert.equal(result.rows.length, 500);
    assert.deepEqual([result.truncated, result.outOfTime], [true, true]);
    assert.equal(
      exportNote({ exported: result.rows.length, total: result.total, truncated: result.truncated, outOfTime: result.outOfTime }, "tasks"),
      "Exported 500 of 9,000 tasks, ran out of time.",
    );
    const quick = await collectForExport(fakeList(300).load, { budgetMs: 5_000, now: () => 0 });
    assert.deepEqual([quick.rows.length, quick.outOfTime], [300, false]);
  });

  it("stops when a page comes back empty", async () => {
    const result = await collectForExport(async () => ({ data: [] as number[], total: 40 }));
    assert.deepEqual(result, { rows: [], total: 40, truncated: true, outOfTime: false });
  });
});

describe("CSV export from the database", () => {
  let owner: UserActor;

  before(async () => {
    await resetDatabase();
    owner = await createUser("export@orbit.test", "Mark Ridgeon");
    for (let index = 0; index < 230; index += 1) {
      await createContact(owner, { firstName: "Person", lastName: String(index).padStart(3, "0"), email: `person${index}@export.test` });
    }
  });

  after(async () => {
    await getPool().end();
  });

  it("pages through every contact and reports the counts", async () => {
    const result = await exportContactsCsv(owner);
    assert.equal(result.rows.length, 231);
    assert.deepEqual([result.exported, result.total, result.truncated], [230, 230, false]);
    assert.equal(new Set(result.rows.slice(1).map((row) => row[2])).size, 230);
  });
});
