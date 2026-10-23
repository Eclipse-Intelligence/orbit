import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { runMindcase } from "@/lib/mindcase";
import { socialLookup } from "@/lib/social-lookup";
import { createUser, resetDatabase } from "./helpers";

type Call = { url: string; method: string; body: Record<string, unknown> | null; auth: string | null };

function mindcase(replies: ((call: Call) => Response)[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get("authorization") };
    calls.push(call);
    return replies[Math.min(calls.length - 1, replies.length - 1)](call);
  };
  return { fetchImpl, calls };
}

const PROFILE = {
  profileUrl: "https://www.linkedin.com/in/andrew",
  firstName: "Andrew",
  lastName: "Sanaghan",
  headline: "CEO at Secro",
  city: "Leeds",
  country: "GB",
  about: "Building Secro.",
  followers: 1200,
  experience: [
    { title: "Chief Executive", company: { name: "Secro" }, startDate: "Sep 2026", endDate: "Present" },
    { title: "Managing Director", company: { name: "Pulse" }, startDate: "2019", endDate: "Aug 2026" },
  ],
};

describe("Mindcase lookups", () => {
  let owner: UserActor;
  let contactId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@mindcase.test", "Mark Ridgeon");
    const pulse = (await createCompany(owner, { name: "Pulse", domain: "pulse.test" })).body.company.id;
    contactId = (await createContact(owner, { firstName: "Andrew", email: "andrew@pulse.test", companyId: pulse, linkedinUrl: "https://www.linkedin.com/in/andrew" })).body.contact.id;
  });

  beforeEach(() => {
    process.env.MINDCASE_API_KEY = "mk_live_test";
  });

  afterEach(() => {
    delete process.env.MINDCASE_API_KEY;
    delete process.env.MINDCASE_MONTHLY_LIMIT_USD;
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("reads a LinkedIn profile, waits for slow runs and records what it cost", async () => {
    const { fetchImpl, calls } = mindcase([
      () => Response.json({ job_id: "job-1", status: "running", data: [] }),
      () => Response.json({ job_id: "job-1", status: "completed", data: [PROFILE] }),
    ]);
    const found = (await socialLookup(owner, "linkedin_profile", "linkedin.com/in/andrew?trk=x", 1, { fetchImpl })) as { profile: { name: string; headline: string; location: string; experience: { title: string; company: string; current?: boolean }[] } };
    assert.equal(calls[0].url, "https://api.mindcase.co/v1/data/linkedin/profiles/run?wait=true");
    assert.equal(calls[0].auth, "Bearer mk_live_test");
    assert.deepEqual(calls[0].body, { params: { queries: ["https://linkedin.com/in/andrew"] } });
    assert.equal(calls[1].url, "https://api.mindcase.co/v1/jobs/job-1/results");
    assert.equal(found.profile.name, "Andrew Sanaghan");
    assert.equal(found.profile.location, "Leeds, GB");
    assert.deepEqual(found.profile.experience[0], { title: "Chief Executive", company: "Secro", from: "Sep 2026", to: "Present", current: true });
    assert.equal(found.profile.experience[1].current, undefined);
    const usage = await getAdminPool().query("select agent, rows, cost_usd::text as cost from crm.data_usage");
    assert.deepEqual(usage.rows, [{ agent: "linkedin/profiles", rows: 1, cost: "0.00400" }]);
  });

  it("uses the contact's LinkedIn link from the assistant, explains bad links and empty wallets, and stops at the monthly limit", async () => {
    const { fetchImpl } = mindcase([() => Response.json({ status: "completed", data: [PROFILE] })]);
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const viaTool = (await runTool(owner, "social_lookup", { kind: "linkedin_profile", contactId })) as { profile: { headline: string } };
      assert.equal(viaTool.profile.headline, "CEO at Secro");
      assert.match(((await runTool(owner, "social_lookup", { kind: "linkedin_company", url: "https://www.linkedin.com/in/andrew" })) as { error: string }).error, /isn't a LinkedIn company link/);
    } finally {
      globalThis.fetch = original;
    }
    const broke = mindcase([() => Response.json({ detail: "Insufficient balance" }, { status: 402 })]);
    await assert.rejects(socialLookup(owner, "x_profile", "@andrew", 1, { fetchImpl: broke.fetchImpl }), /wallet is empty/);
    process.env.MINDCASE_MONTHLY_LIMIT_USD = "0.005";
    const capped = mindcase([() => Response.json({ status: "completed", data: [] })]);
    await assert.rejects(runMindcase(owner, "linkedin/profiles", { queries: ["https://www.linkedin.com/in/x"] }, { source: "test", expectedRows: 1, fetchImpl: capped.fetchImpl }), /reached the \$0\.005 limit/);
    assert.equal(capped.calls.length, 0);
  });

  it("reads recent X posts by handle", async () => {
    const { fetchImpl, calls } = mindcase([() => Response.json({ status: "completed", data: [{ tweetUrl: "https://x.com/andrew/status/1", tweetText: "We just raised.", postedDate: "2026-10-20", likes: 40 }] })]);
    const found = (await socialLookup(owner, "x_posts", "https://x.com/andrew", 3, { fetchImpl })) as { posts: { text: string }[] };
    assert.deepEqual(calls[0].body, { params: { inputs: "andrew", maxResults: 3 } });
    assert.equal(found.posts[0].text, "We just raised.");
  });
});
