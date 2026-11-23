import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureBadgeFrom, NO_CAPTURE_COUNTS } from "@/stores/companies-store";
import { visitDue, resetVisitThrottle } from "@/lib/visit-throttle";

describe("capture badge from a status", () => {
  const sections = { approvals: 1, followUps: 2, replies: 3, toFile: 4 };

  it("sums the sections and keeps the freshness", () => {
    const badge = captureBadgeFrom({ fresh: 2, newestAt: "2026-11-23T10:00:00.000Z", sections, failed: [] }, null);
    assert.deepEqual(badge, { waiting: 10, fresh: 2, newestAt: "2026-11-23T10:00:00.000Z", sections });
  });

  it("keeps the known count for a section that failed to load", () => {
    const known = { waiting: 7, fresh: 0, newestAt: null, sections: { approvals: 0, followUps: 0, replies: 0, toFile: 7 } };
    const badge = captureBadgeFrom({ fresh: 0, newestAt: null, sections: { ...sections, toFile: 0 }, failed: ["toFile"] }, known);
    assert.equal(badge.sections.toFile, 7);
    assert.equal(badge.waiting, 1 + 2 + 3 + 7);
  });

  it("counts a failed section as none when nothing was known", () => {
    const badge = captureBadgeFrom({ fresh: 0, newestAt: null, sections, failed: ["approvals", "followUps", "replies", "toFile"] }, null);
    assert.deepEqual(badge.sections, NO_CAPTURE_COUNTS);
    assert.equal(badge.waiting, 0);
  });
});

describe("visit throttle", () => {
  it("lets a key through once per gap", () => {
    resetVisitThrottle();
    assert.equal(visitDue("a", 1000, 0), true);
    assert.equal(visitDue("a", 1000, 999), false);
    assert.equal(visitDue("b", 1000, 999), true);
    assert.equal(visitDue("a", 1000, 1000), true);
  });
});
