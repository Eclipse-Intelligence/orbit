import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createCompany, getCompany } from "@/lib/crm/companies";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool } from "@/lib/db/pool";
import { getEnrichmentSettings, saveEnrichmentSettings } from "@/lib/enrichment/settings";
import { readFileSync } from "node:fs";
import { backfillWebChecks, checkCompany, ensureDefaultSignals, getCompanyFit, icpProfile, learnedIcp, runWebSignals, saveWebCheck, uncheckedCompanyCount } from "@/lib/enrichment/web-checks";
import { icpHashOf } from "@/lib/enrichment/settings";
import { runScheduledSync } from "@/lib/crm/scheduler";
import { createAgent } from "./helpers";
import { listCompanies } from "@/lib/crm/companies";
import { checkWeb } from "@/lib/assistant/check-web";
import { decide } from "@/lib/parallel";
import { createUser, resetDatabase } from "./helpers";

const ENV = { PARALLEL_API_KEY: "par_test" };

type Sent = { url: string; headers: Record<string, string>; body: { state: Record<string, unknown>; questions: Record<string, { type: string; instructions: string; criteria?: unknown }> } };

function parallel(reply: (body: Sent["body"]) => Record<string, unknown> | Response) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as Sent["body"];
    sent.push({ url: String(input), headers: init.headers as Record<string, string>, body });
    const answer = reply(body);
    return answer instanceof Response ? answer : Response.json(answer);
  }) as typeof fetch;
  return { sent, fetchImpl };
}

function noul(value: number) {
  return { type: "noul", noul: value };
}

describe("web checks", () => {
  let owner: UserActor;
  let member: UserActor;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@web.test", "Mark Ridgeon");
    const sam = (await getAdminPool().query<{ id: string }>("select private.create_local_user('sam@web.test', 'password-123', 'Sam Colleague') as id")).rows[0].id;
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, sam]);
    member = { ...owner, userId: sam, email: "sam@web.test", fullName: "Sam Colleague", role: "member", scopes: scopesForRole("member") };
    await createCompany(owner, { name: "Old Agency", domain: "old.test", industry: "Content / SEO agency" });
    await createCompany(owner, { name: "Money Co", domain: "money.test", industry: "Fintech" });
  });

  it("reads typed answers, refusals and citations from the Decisions API", async () => {
    const api = parallel(() => ({
      answers: { yes: noul(0.97), pick: { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9 } }, nope: { type: "refusal" } },
      citations: [{ url: "https://news.test/a", title: "A", excerpts: ["One"] }, { url: "javascript:alert(1)" }],
      decision_id: "decisions_1",
    }));
    const decision = await decide(
      { company: "Clay" },
      { yes: { type: "noul", instructions: "Q?" }, pick: { type: "choice", instructions: "Which?", criteria: { a: "A", b: "B" } }, nope: { type: "noul", instructions: "Q2?" } },
      { fetchImpl: api.fetchImpl, env: ENV },
    );
    assert.equal(api.sent[0].url, "https://api.parallel.ai/v1/decisions");
    assert.equal(api.sent[0].headers["x-api-key"], "par_test");
    assert.deepEqual(decision.answers.yes, { type: "noul", noul: 0.97 });
    assert.equal(decision.answers.pick.type === "choice" && decision.answers.pick.choice, "b");
    assert.deepEqual(decision.answers.nope, { type: "refusal" });
    assert.deepEqual(decision.citations, [{ url: "https://news.test/a", title: "A", excerpts: ["One"] }]);
    await assert.rejects(decide({}, { q: { type: "noul", instructions: "Q?" } }, { env: {} }), /PARALLEL_API_KEY/);
    const denied = parallel(() => new Response("no", { status: 401 }));
    await assert.rejects(decide({}, { q: { type: "noul", instructions: "Q?" } }, { fetchImpl: denied.fetchImpl, env: ENV }), /rejected the key/);
  });

  it("only lets owners and admins change rules, and keeps tag names tidy", async () => {
    await assert.rejects(saveWebCheck(member, { kind: "tag", label: "agency", question: "Is the company an agency?" }), /owners and admins/);
    await assert.rejects(saveWebCheck(owner, { kind: "tag", label: "agency", question: "Agency?" }), /10 to 1,000/);
    const rule = await saveWebCheck(owner, { kind: "tag", label: "  Agency ", question: "Is the company a marketing, content or SEO agency?" });
    assert.equal(rule.label, "agency");
    await assert.rejects(saveWebCheck(owner, { kind: "tag", label: "AGENCY", question: "Is the company a marketing agency?" }), /already a check for agency/);
    await saveWebCheck(owner, { kind: "tag", label: "fintech", question: "Is the company a financial technology business?" });
  });

  it("adds confident tags and fills only the gaps context.dev left", async () => {
    const pulse = (await createCompany(owner, { name: "Pulse", domain: "pulse.test", description: "Private notes about Pulse" })).body.company;
    const api = parallel((body) => ({
      answers: {
        tag_0: noul(0.93),
        tag_1: noul(0.6),
        ...(body.questions.size ? { size: { type: "choice", choice: "s2", probabilities: { s2: 0.8, unknown: 0.2 } } } : {}),
        ...(body.questions.industry ? { industry: { type: "choice", choice: "i0", probabilities: { i0: 0.75, other: 0.25 } } } : {}),
      },
      citations: [],
    }));
    const result = await checkCompany(owner, pulse.id, { tags: true, gaps: true, fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(result.status, "updated");
    assert.deepEqual(result.tags, ["agency"]);
    const sent = api.sent[0].body;
    assert.deepEqual(Object.keys(sent.state).sort(), ["company", "domain", "today"]);
    assert.ok(!JSON.stringify(sent).includes("Private notes"));
    assert.deepEqual(Object.keys(sent.questions).sort(), ["industry", "size", "tag_0", "tag_1"]);
    assert.deepEqual(sent.questions.industry.criteria, { i0: "Content / SEO agency", i1: "Fintech", other: "None of these describe the company." });
    const updated = await getCompany(owner, pulse.id);
    assert.deepEqual(updated.tags, ["agency"]);
    assert.equal(updated.sizeCategory, "11-50");
    assert.equal(updated.industry, "Content / SEO agency");

    const sized = (await createCompany(owner, { name: "Sized", domain: "sized.test", sizeCategory: "~25", industry: "Fintech", tags: ["agency"] })).body.company;
    const second = parallel(() => ({ answers: { tag_0: noul(0.99) }, citations: [] }));
    await checkCompany(owner, sized.id, { tags: true, gaps: true, fetchImpl: second.fetchImpl, env: ENV });
    assert.deepEqual(Object.keys(second.sent[0].body.questions), ["tag_0"]);
    const kept = await getCompany(owner, sized.id);
    assert.equal(kept.sizeCategory, "~25");
    assert.deepEqual(kept.tags.sort(), ["agency", "fintech"]);

    const vague = (await createCompany(owner, { name: "Vague", domain: "vague.test" })).body.company;
    const refused = parallel(() => ({ answers: { tag_0: { type: "refusal" }, tag_1: { type: "refusal" }, size: { type: "choice", choice: "unknown", probabilities: { unknown: 0.9 } } }, citations: [] }));
    const nothing = await checkCompany(owner, vague.id, { tags: true, gaps: true, fetchImpl: refused.fetchImpl, env: ENV });
    assert.equal(nothing.status, "unchanged");
    const untouched = await getCompany(owner, vague.id);
    assert.deepEqual(untouched.tags, []);
    assert.equal(untouched.sizeCategory, null);
  });

  it("checks existing companies in batches until none are left", async () => {
    await saveEnrichmentSettings(owner, { webGaps: true });
    assert.equal((await getEnrichmentSettings(owner)).autoCompanies, true);
    const before = await uncheckedCompanyCount(owner);
    assert.ok(before > 0);
    const api = parallel(() => ({ answers: {}, citations: [] }));
    const run = await backfillWebChecks(owner, { fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(run.results.length, before);
    assert.equal(run.remaining, 0);

    const full = (await createCompany(owner, { name: "Full Co", domain: "full.test", sizeCategory: "11-50", industry: "Fintech", tags: ["agency", "fintech"] })).body.company;
    const quiet = parallel(() => ({ answers: {}, citations: [] }));
    const nothing = await checkCompany(owner, full.id, { tags: true, gaps: true, fetchImpl: quiet.fetchImpl, env: ENV });
    assert.equal(nothing.message, "Nothing to check.");
    assert.equal(quiet.sent.length, 0);
    assert.equal(await uncheckedCompanyCount(owner), 0);

    await saveWebCheck(owner, { kind: "tag", label: "saas", question: "Does the company sell software as a service?" });
    const withSites = await getAdminPool().query<{ total: number }>("select count(*)::int as total from crm.companies where workspace_id = $1 and archived_at is null and domain is not null", [owner.workspaceId]);
    assert.equal(await uncheckedCompanyCount(owner), withSites.rows[0].total);
  });

  it("flags weekly signals on customers into market notes, once", async () => {
    await saveEnrichmentSettings(owner, { webSignals: true });
    const signals = await ensureDefaultSignals(owner);
    assert.equal(signals.length, 6);
    assert.equal((await ensureDefaultSignals(owner)).length, 6);
    const client = (await createCompany(owner, { name: "Client Ltd", domain: "client.test", lifecycle: "customer" })).body.company;
    await createCompany(owner, { name: "Cold Lead", domain: "lead.test", lifecycle: "lead" });
    const api = parallel(() => ({
      answers: { signal_0: noul(0.91), signal_1: noul(0.85), signal_2: noul(0.1), signal_3: { type: "refusal" }, signal_4: noul(0.2), signal_5: noul(0.3) },
      citations: [
        { url: "https://client.test/news", title: "Our news", excerpts: ["We raised"] },
        { url: "https://press.test/client-raises", title: "Client Ltd raises £5m", excerpts: ["Client Ltd has raised £5m led by Fund."] },
      ],
    }));
    const first = await runWebSignals(owner, { deadline: Date.now() + 30_000, fetchImpl: api.fetchImpl, env: ENV });
    assert.deepEqual(first, { checked: 1, flagged: 2, failed: 0 });
    assert.equal(api.sent[0].body.state.company, "Client Ltd");
    const notes = await getAdminPool().query<{ kind: string; headline: string; url: string; company_id: string; summary: string }>(
      "select kind, headline, url, company_id, summary from crm.market_notes where workspace_id = $1",
      [owner.workspaceId],
    );
    assert.equal(notes.rows.length, 1);
    assert.equal(notes.rows[0].headline, "Client Ltd: Raised money, New leader");
    assert.equal(notes.rows[0].kind, "funding");
    assert.equal(notes.rows[0].url, "https://press.test/client-raises");
    assert.equal(notes.rows[0].company_id, client.id);
    assert.equal(notes.rows[0].summary, "Web check: Raised money (91% likely), New leader (85% likely). Source: Client Ltd raises £5m");
    assert.equal((api.sent[0].body as { include_excerpts?: boolean }).include_excerpts, false);

    const again = await runWebSignals(owner, { deadline: Date.now() + 30_000, fetchImpl: api.fetchImpl, env: ENV });
    assert.deepEqual(again, { checked: 0, flagged: 0, failed: 0 });

    await getAdminPool().query("update crm.company_web_state set signals_checked_at = now() - interval '8 days' where company_id = $1", [client.id]);
    const later = parallel(() => ({ answers: {}, citations: [] }));
    await runWebSignals(owner, { deadline: Date.now() + 30_000, fetchImpl: later.fetchImpl, env: ENV });
    assert.equal(Object.keys(later.sent[0].body.questions).length, 4);

    await getAdminPool().query("update crm.company_web_state set signals_checked_at = now() - interval '8 days' where company_id = $1", [client.id]);
    const broken = parallel(() => new Response("down", { status: 500 }));
    const failed = await runWebSignals(owner, { deadline: Date.now() + 30_000, fetchImpl: broken.fetchImpl, env: ENV });
    assert.equal(failed.failed, 1);
    const retry = await getAdminPool().query<{ due: boolean }>(
      "select signals_checked_at < now() - interval '7 days' + interval '61 minutes' as due from crm.company_web_state where company_id = $1",
      [client.id],
    );
    assert.equal(retry.rows[0].due, true);

    await saveEnrichmentSettings(owner, { webSignals: false });
    assert.deepEqual(await runWebSignals(owner, { deadline: Date.now() + 30_000, fetchImpl: api.fetchImpl, env: ENV }), { skipped: "Weekly signals are off." });
  });

  it("scores ICP fit with sources, sorts by it, and rescores when the ICP changes", async () => {
    await getAdminPool().query(
      "insert into crm.memories (workspace_id, scope, kind, title, body) values ($1, 'business', 'icp', 'Content agencies', 'UK content and SEO agencies of 10 to 50 people.')",
      [owner.workspaceId],
    );
    assert.equal(await icpProfile(owner), null);
    await saveEnrichmentSettings(owner, { webIcp: true, webTags: false, webGaps: false });
    const learned = await icpProfile(owner);
    assert.match(learned!.text, /Ideal customer: Content agencies/);
    assert.equal((await getEnrichmentSettings(owner)).icpText, learned!.text);
    await getAdminPool().query(
      "insert into crm.memories (workspace_id, scope, kind, title, body) values ($1, 'business', 'audience', 'Founders', 'Agency founders who run delivery themselves.')",
      [owner.workspaceId],
    );
    assert.equal((await icpProfile(owner))?.hash, learned!.hash);

    const snapshot = readFileSync("supabase/migrations/20261206100000_parallel_review.sql", "utf8");
    await getAdminPool().query("update crm.enrichment_settings set icp_text = null, icp_hash = null where workspace_id = $1", [owner.workspaceId]);
    await getAdminPool().query(snapshot.slice(snapshot.indexOf("with learned as")));
    const fromSql = await getEnrichmentSettings(owner);
    assert.equal(fromSql.icpText, await learnedIcp(owner));
    assert.equal(fromSql.icpHash, icpHashOf(fromSql.icpText!));
    await getAdminPool().query("update crm.enrichment_settings set icp_text = $2, icp_hash = $3 where workspace_id = $1", [owner.workspaceId, learned!.text, learned!.hash]);
    const target = (await createCompany(owner, { name: "Fit Agency", domain: "fit.test", sizeCategory: "11-50", industry: "Fintech" })).body.company;
    const api = parallel((body) => ({
      answers: { ...(body.questions.icp ? { icp: { type: "score", score: 3.27, probabilities: { "3": 0.7, "4": 0.3 }, legend: {} } } : {}) },
      citations: [{ url: "https://fit.test/about", title: "About Fit", excerpts: ["We are a content agency"] }],
    }));
    const result = await checkCompany(owner, target.id, { tags: false, gaps: false, icp: learned, fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(result.status, "updated");
    const sent = api.sent[0].body;
    assert.equal(sent.questions.icp.type, "score");
    assert.equal((sent.questions.icp.criteria as string[]).length, 5);
    assert.match(String(sent.state.ideal_customer_profile), /UK content and SEO agencies/);
    const fit = await getCompanyFit(owner, target.id);
    assert.equal(fit?.score, 3.3);
    assert.equal(fit?.label, "Good fit");
    assert.deepEqual(fit?.sources, [{ url: "https://fit.test/about", title: "About Fit" }]);
    assert.equal(fit?.stale, false);

    const sorted = await listCompanies(owner, { sort: "fit", order: "desc", limit: 3 });
    assert.equal(sorted.data[0].id, target.id);
    assert.equal(sorted.data[0].icpFit, 3.3);

    const dueBefore = await uncheckedCompanyCount(owner);
    await saveEnrichmentSettings(owner, { icpText: "B2B SaaS companies in fintech with 50 to 200 staff." });
    assert.equal((await icpProfile(owner))?.text, "B2B SaaS companies in fintech with 50 to 200 staff.");
    assert.equal(await uncheckedCompanyCount(owner), dueBefore + 1);
    assert.equal((await getCompanyFit(owner, target.id))?.stale, true);
    assert.equal((await listCompanies(owner, { sort: "fit", order: "desc", limit: 100 })).data.find((company) => company.id === target.id)?.icpFit, null);
    await saveEnrichmentSettings(owner, { webIcp: false });
    assert.equal(await getCompanyFit(owner, target.id), null);
    await saveEnrichmentSettings(owner, { webIcp: true });
    await assert.rejects(saveEnrichmentSettings(owner, { icpText: "x".repeat(20_001) }), /under 20,000/);
  });

  it("checks facts for the assistant and reports refusals as unknown", async () => {
    const api = parallel(() => ({
      answers: {
        has_funding: noul(0.81),
        model: { type: "choice", choice: "o1", probabilities: { o0: 0.1, o1: 0.85, unknown: 0.05 } },
        maturity: { type: "score", score: 1.44, probabilities: {} },
        leader: { type: "refusal" },
      },
      citations: [{ url: "https://news.test/pulse", title: "Pulse raises", excerpts: ["Pulse raised £2m.", "Second passage."] }],
    }));
    const result = (await checkWeb(
      {
        about: "Pulse, pulse.test",
        questions: [
          { key: "has_funding", type: "yes_no", question: "Has Pulse raised money this year?" },
          { key: "model", type: "choice", question: "How does Pulse sell?", options: ["Self-serve", "Sales-led"] },
          { key: "maturity", type: "score", question: "How mature is Pulse's content marketing?", options: ["None", "Some", "Strong"] },
          { key: "leader", type: "yes_no", question: "Is Jo the CEO?" },
        ],
      },
      { fetchImpl: api.fetchImpl, env: ENV },
    )) as { answers: Record<string, Record<string, unknown>>; sources: { excerpts: string[] }[] };
    assert.deepEqual(api.sent[0].body.state.about, "Pulse, pulse.test");
    assert.equal(result.answers.has_funding.likelihood, 81);
    assert.equal(result.answers.model.choice, "Sales-led");
    assert.equal(result.answers.model.confidence, 85);
    assert.equal(result.answers.maturity.score, 1.4);
    assert.equal(result.answers.maturity.of, 2);
    assert.equal(result.answers.leader.answer, null);
    assert.deepEqual(result.sources[0].excerpts, ["Pulse raised £2m.", "Second passage."]);
    assert.deepEqual(await checkWeb({ about: "Pulse", questions: [{ key: "x", type: "choice", question: "Which?", options: ["One"] }] }, { env: ENV }), { error: "x: give 2 to 50 options." });
    assert.deepEqual(await checkWeb({ about: "Pulse", questions: [{ key: "x", type: "yes_no", question: "Q?" }] }, { env: {} }), { error: "Add PARALLEL_API_KEY in Vercel to run web checks." });
  });

  it("saves the check for companies an agent creates", async () => {
    const { actor: agent } = await createAgent(owner.workspaceId, ["crm:read", "companies:write"]);
    await saveEnrichmentSettings(owner, { webTags: true, webGaps: false, webIcp: false });
    const made = (await createCompany(agent, { name: "Agent Co", domain: "agentco.test" })).body.company;
    const api = parallel((body) => ({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, noul(0.1)])), citations: [] }));
    const result = await checkCompany(agent, made.id, { tags: true, gaps: false, fetchImpl: api.fetchImpl, env: ENV });
    assert.notEqual(result.status, "failed");
    const state = await getAdminPool().query<{ checked: boolean }>("select checked_at is not null as checked from crm.company_web_state where company_id = $1", [made.id]);
    assert.equal(state.rows[0]?.checked, true);
  });

  it("marks a company checked when saving fails after the paid call, so it isn't asked again", async () => {
    const full = (await createCompany(owner, { name: "Twenty Tags", domain: "twenty.test", tags: Array.from({ length: 20 }, (_, index) => `tag${index}`) })).body.company;
    const api = parallel((body) => ({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, noul(0.99)])), citations: [] }));
    const result = await checkCompany(owner, full.id, { tags: true, gaps: false, fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(result.status, "failed");
    assert.match(result.message, /20 tags/);
    const state = await getAdminPool().query<{ checked: boolean }>("select checked_at is not null as checked from crm.company_web_state where company_id = $1", [full.id]);
    assert.equal(state.rows[0]?.checked, true);
  });

  it("never pays twice for a company when two people check existing companies at once", async () => {
    for (let index = 0; index < 6; index += 1) await createCompany(owner, { name: `Batch ${index}`, domain: `batch${index}.test` });
    await getAdminPool().query("update crm.company_web_state set checked_at = null, check_claimed_at = null where workspace_id = $1", [owner.workspaceId]);
    const asked = new Map<string, number>();
    const api = parallel((body) => {
      const name = String(body.state.company);
      asked.set(name, (asked.get(name) ?? 0) + 1);
      return { answers: {}, citations: [] };
    });
    await Promise.all([backfillWebChecks(owner, { fetchImpl: api.fetchImpl, env: ENV }), backfillWebChecks(owner, { fetchImpl: api.fetchImpl, env: ENV })]);
    assert.ok(asked.size > 0);
    assert.ok([...asked.values()].every((count) => count === 1), JSON.stringify([...asked]));
  });

  it("keeps a note for each company when two signals cite the same article", async () => {
    await saveEnrichmentSettings(owner, { webSignals: true });
    const first = (await createCompany(owner, { name: "Shared One", domain: "shared1.test", lifecycle: "customer" })).body.company;
    const second = (await createCompany(owner, { name: "Shared Two", domain: "shared2.test", lifecycle: "customer" })).body.company;
    await getAdminPool().query(
      "update crm.company_web_state set signals_checked_at = now() where workspace_id = $1 and company_id <> all($2::uuid[])",
      [owner.workspaceId, [first.id, second.id]],
    );
    await getAdminPool().query(
      `insert into crm.company_web_state (company_id, workspace_id, signals_checked_at)
       select c.id, c.workspace_id, now() from crm.companies c where c.workspace_id = $1 and c.id <> all($2::uuid[])
       on conflict (company_id) do update set signals_checked_at = now()`,
      [owner.workspaceId, [first.id, second.id]],
    );
    const api = parallel(() => ({ answers: { signal_0: noul(0.95) }, citations: [{ url: "https://news.test/roundup", title: "Funding roundup", excerpts: [] }] }));
    await runWebSignals(owner, { deadline: Date.now() + 30_000, fetchImpl: api.fetchImpl, env: ENV });
    const notes = await getAdminPool().query<{ company_id: string; url: string | null }>(
      "select company_id, url from crm.market_notes where company_id = any($1::uuid[]) order by created_at",
      [[first.id, second.id]],
    );
    assert.equal(notes.rows.length, 2);
    assert.deepEqual(notes.rows.map((row) => row.url), ["https://news.test/roundup", null]);
  });

  it("retries Parallel once when it is busy and refuses requests over its limits", async () => {
    let calls = 0;
    const busy = (async () => {
      calls += 1;
      return calls === 1 ? new Response("slow down", { status: 429 }) : Response.json({ answers: { q: noul(0.7) }, citations: [] });
    }) as typeof fetch;
    const decision = await decide({ company: "X" }, { q: { type: "noul", instructions: "Q?" } }, { fetchImpl: busy, env: ENV, retryPauseMs: 1 });
    assert.equal(calls, 2);
    assert.deepEqual(decision.answers.q, { type: "noul", noul: 0.7 });
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`q${index}`, { type: "noul" as const, instructions: "Q?" }]));
    await assert.rejects(decide({}, many, { env: ENV }), /up to 100 questions/);
    await assert.rejects(decide({}, { long: { type: "noul", instructions: "x".repeat(5_000) } }, { env: ENV }), /too long/);
  });

  it("runs weekly signals once per workspace in each sync", async () => {
    let runs = 0;
    const step = { name: "once", oncePerWorkspace: true, applies: () => true, run: async () => ({ runs: ++runs }) };
    const target = { actor: owner, mailbox: false, members: [owner, member], granola: null };
    await runScheduledSync({ steps: [step], targets: [target, { ...target, actor: member }], budgetMs: 30_000 });
    assert.equal(runs, 1);
  });
});
