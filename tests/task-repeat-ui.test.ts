import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Task, TaskRepeat } from "@/lib/crm/types";
import { dayStartIso } from "@/lib/crm/task-time";
import { TASK_PAGE_PATHS } from "@/lib/revalidate";
import { checkEnds, checkRule, repeatInputOf, type RepeatRule } from "@/lib/task-repeat";
import {
  countLeft,
  draftOf,
  endsOf,
  endsOnFirst,
  menuFocus,
  monthlyLabel,
  nextDetail,
  nextLabel,
  patternInputOf,
  ruleOf,
  sameEnds,
  sameRepeat,
  scopeChange,
  scopeTexts,
  skippedMessage,
  skipsBesideRepeat,
  waitsForScope,
} from "@/lib/task-repeat-menu";

const MARK = "11111111-1111-4111-8111-111111111111";
const SAM = "22222222-2222-4222-8222-222222222222";

function repeat(overrides: Partial<TaskRepeat> = {}): TaskRepeat {
  return {
    seriesId: "33333333-3333-4333-8333-333333333333",
    ownerId: MARK,
    creatorId: MARK,
    startsOn: "2026-11-16",
    at: "09:00",
    rule: { freq: "weekly", interval: 1, weekdays: ["mo"] },
    ends: { never: true },
    current: true,
    ended: false,
    next: { occursOn: "2026-11-23", dueAt: "2026-11-23T09:00:00.000Z", dueHasTime: true },
    text: "Every Monday at 09:00",
    phrase: "Repeats every Monday at 09:00",
    short: "Every Monday",
    end: "",
    rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO",
    changedDates: 0,
    skippedDates: [],
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    title: "Team call",
    description: null,
    dueAt: "2026-11-16T09:00:00.000Z",
    dueDate: null,
    dueHasTime: true,
    occursOn: "2026-11-16",
    completedAt: null,
    archivedAt: null,
    ownerId: MARK,
    repeat: repeat(),
    ...overrides,
  } as Task;
}

const source = (path: string) => readFileSync(path, "utf8");

describe("repeat menu and fields", () => {
  it("shows the moved day as next, not the pattern day", () => {
    const moved = { occursOn: "2026-11-23", dueAt: "2026-11-25T10:00:00.000Z", dueHasTime: true };
    assert.equal(nextDetail(moved), "Next: Wed 25 Nov");
    assert.equal(nextLabel(moved), "Wed 25 Nov, 10:00");
    const plain = { occursOn: "2026-11-23", dueAt: dayStartIso("2026-11-27"), dueHasTime: false };
    assert.equal(nextDetail(plain), "Next: Fri 27 Nov");
    const texts = scopeTexts(task({ repeat: repeat({ next: moved }) }), { kind: "time", to: "11:00" }, "2026-11-16");
    assert.match(texts.one, /Wed 25 Nov is back at 09:00/);
  });

  it("asks where removing the time applies, like any other time change", () => {
    const change = scopeChange(task(), { dueDate: "2026-11-16" });
    assert.deepEqual(change, { kind: "untime" });
    const texts = scopeTexts(task(), change!, "2026-11-16");
    assert.equal(texts.line, "Removing the time from today's.");
    assert.match(texts.all, /^Today and every later one lose the time\./);
    assert.equal(scopeChange(task(), { dueDate: "2026-11-18" }), null);
    assert.equal(scopeChange(task({ dueHasTime: false, dueDate: "2026-11-16", dueAt: dayStartIso("2026-11-16") }), { dueDate: "2026-11-16" }), null);
  });

  it("offers Skip beside the repeat to a handed-on assignee who can't change the series", () => {
    const handed = task({ ownerId: SAM, repeat: repeat({ ownerId: MARK, creatorId: MARK }) });
    assert.equal(skipsBesideRepeat(handed, SAM, true), true);
    assert.equal(skipsBesideRepeat(handed, MARK, true), false);
    assert.equal(skipsBesideRepeat(handed, SAM, false), false);
    assert.equal(skipsBesideRepeat(task({ repeat: repeat({ ended: true }) }), SAM, true), false);
  });

  it("keeps the weekday row on one line in the phone popover", () => {
    const file = source("components/crm/task-repeat.tsx");
    const buttons = 7 * 32 + 6 * 12;
    const coarse = file.match(/\[@media\(pointer:coarse\)\]:w-\[min\((\d+)rem,calc\(100vw-2rem\)\)\]/g) ?? [];
    assert.equal(coarse.length, 2);
    const width = Number(/min\((\d+)rem/.exec(coarse[0])![1]) * 16 - 28;
    assert.ok(width >= buttons, `${width} < ${buttons}`);
    assert.ok(390 - 32 - 28 >= buttons);
  });

  it("shows how many are left beside the count in the custom editor", () => {
    const live = { ends: { count: 10, spent: 4 }, end: "6 more" };
    assert.equal(countLeft(live, "10"), 6);
    assert.equal(countLeft(live, "12"), 8);
    assert.equal(countLeft(live, "3"), 0);
    assert.equal(countLeft({ ends: { never: true }, end: "" }, "10"), null);
    assert.equal(countLeft(null, "10"), null);
    assert.match(source("components/crm/task-repeat.tsx"), /\{left\} more/);
  });

  it("labels the monthly choice with the day that is saved", () => {
    const original: RepeatRule = { freq: "monthly", interval: 1, monthDay: 31 };
    assert.equal(monthlyLabel("day", "2026-11-30", original), "Day 31");
    assert.deepEqual(ruleOf(draftOf({ rule: original, ends: { never: true } }, "2026-11-30"), "2026-11-30", original), original);
    assert.equal(monthlyLabel("day", "2026-11-30", null), "Day 30");
    const week: RepeatRule = { freq: "monthly", interval: 1, monthWeek: { n: 2, weekday: "tu" } };
    assert.equal(monthlyLabel("week", "2026-11-17", week), "The second Tuesday");
    assert.equal(monthlyLabel("week", "2026-11-24", week), "The second Tuesday");
    assert.equal(monthlyLabel("last", "2026-11-24", week), "The last Tuesday");
  });

  it("keeps a series panel open until the server has saved it", () => {
    const file = source("components/crm/task-repeat.tsx");
    assert.doesNotMatch(file, /close\(\);\s*void actions\.(set|end|stop|remove)\(/);
    assert.match(file, /if \(\(await work\(\)\) && shownAt\.current === shown\) close\(\);/);
  });

  it("never saves a change that needs a scope when the panel goes away", () => {
    assert.equal(waitsForScope(task(), MARK, { title: "Renamed" }), true);
    assert.equal(waitsForScope(task(), MARK, { description: "Notes" }), true);
    assert.equal(waitsForScope(task({ ownerId: SAM }), SAM, { title: "Renamed" }), false);
    assert.equal(waitsForScope(task({ repeat: null }), MARK, { title: "Renamed" }), false);
    const file = source("components/crm/task-repeat.tsx");
    assert.doesNotMatch(file, /kind === "title" \|\| pending\.change\.kind === "description" \? "this"/);
    assert.match(file, /resolve\(SCOPE_LATER\)/);
    assert.match(source("components/crm/task-fields.tsx"), /if \(!ask && waitsForScope\(task, viewerId, write\)\) \{\s*setErrors\(\(current\) => failFields\(current, fields, saveFailedMessage\(fields\)\)\);\s*return false;/);
  });

  it("refreshes the same pages as other task actions", () => {
    const paths = TASK_PAGE_PATHS.map(([path]) => path);
    for (const path of ["/", "/contacts", "/opportunities", "/boards", "/settings/activity", "/tasks", "/calendar"]) assert.ok(paths.includes(path), path);
    const actions = source("app/(crm)/repeats.ts");
    assert.match(actions, /revalidateTaskPages\(\)/);
    assert.doesNotMatch(actions, /revalidatePath\(/);
  });

  it("sends an idempotency key with every repeat action and card create", () => {
    const actions = source("app/(crm)/repeats.ts");
    for (const name of ["setRepeatAction", "skipOccurrenceAction", "endSeriesAction", "deleteSeriesAction"]) {
      const body = actions.slice(actions.indexOf(`export async function ${name}`));
      assert.match(body.slice(0, body.indexOf("\n}\n")), /\.\.\.keyed\(key\)/, name);
    }
    const menu = source("components/crm/task-repeat.tsx");
    assert.match(menu, /const key = newActionKey\(\);/);
    assert.equal((menu.match(/Action\(task\.id, .*key\)/g) ?? []).length, 5);
    assert.match(source("app/(crm)/task-pad.ts"), /idempotencyKey: input\.key/);
    assert.match(source("lib/crm/clickup.ts"), /idempotencyKey: options\.idempotencyKey/);
  });

  it("sends Never as an explicit end, so a live series loses its end", () => {
    const input = repeatInputOf({ freq: "daily", interval: 1 }, { never: true });
    assert.ok("ends" in input);
    assert.equal(input.ends, null);
    assert.deepEqual(repeatInputOf({ freq: "daily", interval: 1 }, { count: 5 }).ends, { after: 5 });
  });

  it("says where a skipped one moved to", () => {
    assert.equal(skippedMessage({ dueAt: "2026-11-23T09:00:00.000Z", dueHasTime: true, occursOn: "2026-11-23" }), "Skipped. Moved to Mon 23 Nov, 09:00.");
    assert.equal(skippedMessage(null), "Skipped.");
  });

  it("submits the scope dialog with Enter and declares the failure message once", () => {
    const file = source("components/crm/task-repeat.tsx");
    assert.match(file, /<form\s+onSubmit=/);
    assert.match(file, /type="submit" variant="primary"/);
    assert.doesNotMatch(file, /const REPEAT_SAVE_FAILED/);
    assert.doesNotMatch(source("app/(crm)/repeats.ts"), /REPEAT_SAVE_FAILED,\n/);
  });

  it("gives the repeat menu one tab stop", () => {
    assert.equal(menuFocus(false, null, false), "none");
    assert.equal(menuFocus(true, "weekly", false), "weekly");
    assert.equal(menuFocus(true, null, true), "custom");
    const file = source("components/crm/task-repeat.tsx");
    assert.match(file, /tabIndex=\{active \? 0 : -1\}/);
    assert.match(file, /item\.tabIndex = -1;/);
  });

  it("saves nothing for an unchanged Custom repeat and leaves the end to the server for a new pattern", () => {
    const weekly: RepeatRule = { freq: "weekly", interval: 1, weekdays: ["mo"] };
    assert.equal(sameRepeat(weekly, ruleOf(draftOf({ rule: weekly, ends: { never: true } }, "2026-11-16"), "2026-11-16")), true);
    assert.equal(sameEnds({ count: 10 }, endsOf(draftOf({ rule: weekly, ends: { count: 10 } }, "2026-11-16"))), true);
    assert.equal(sameEnds({ until: "2027-03-15" }, { until: "2027-03-22" }), false);
    assert.equal("ends" in patternInputOf({ freq: "daily", interval: 1 }), false);
    assert.equal(sameRepeat({ freq: "weekly", interval: 1, weekdays: ["mo", "tu", "we", "th", "fr", "sa", "su"] }, { freq: "daily", interval: 1 }), true);
  });

  it("refuses typed numbers it would otherwise rewrite, and an end on the first date", () => {
    const draft = draftOf(null, "2026-11-16");
    for (const typed of ["-3", "1.5", "1000", "1e2", ""]) {
      assert.ok(checkRule(ruleOf({ ...draft, interval: typed }, "2026-11-16")), typed);
      assert.ok(checkEnds(endsOf({ ...draft, ends: "count", count: typed }), "2026-11-16", "2026-11-16"), typed);
    }
    assert.equal(ruleOf({ ...draft, interval: "3" }, "2026-11-16").interval, 3);
    assert.equal(endsOnFirst({ count: 1 }, "2026-11-16"), true);
    assert.equal(endsOnFirst({ until: "2026-11-16" }, "2026-11-16"), true);
    assert.equal(endsOnFirst({ until: "2026-11-17" }, "2026-11-16"), false);
  });
});
