import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectionStrength, relativeWhen } from "@/lib/companies";

const now = Date.parse("2026-10-05T12:00:00Z");

describe("connection strength", () => {
  it("maps recency onto the records-table scale", () => {
    assert.equal(connectionStrength(null, now), "none");
    assert.equal(connectionStrength(new Date(now - 3 * 86_400_000).toISOString(), now), "strong");
    assert.equal(connectionStrength(new Date(now - 20 * 86_400_000).toISOString(), now), "weak");
    assert.equal(connectionStrength(new Date(now - 80 * 86_400_000).toISOString(), now), "veryweak");
    assert.equal(relativeWhen(null, now), "No contact");
    assert.equal(relativeWhen(new Date(now - 3 * 86_400_000).toISOString(), now), "3 days ago");
    assert.equal(relativeWhen(new Date(now - 21 * 86_400_000).toISOString(), now), "3 weeks ago");
  });
});
