import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createCompany, getCompaniesByIds, getCompany, listCompanies } from "@/lib/crm/companies";
import { scopesForRole } from "@/lib/crm/scopes";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool } from "@/lib/db/pool";
import { companiesCsvRows } from "@/lib/companies";
import { companyQueryFromSearchParams } from "@/lib/crm/validation";
import { createCompanyView, deleteCompanyView, listCompanyViews, updateCompanyView } from "@/lib/crm/company-views";
import { saveWebCheck } from "@/lib/enrichment/web-checks";
import { saveEnrichmentSettings, icpHashOf } from "@/lib/enrichment/settings";
import { createTaskRun, getTaskResult, getTaskRun, taskJsonSchema } from "@/lib/parallel";
import { aiFilterValue, aiFiltersFromParams, aiParamKey, aiSortValue, parseAiFilter } from "@/lib/ai-fields/params";
import { costHint, looksLikeStaff, sizeForStaff } from "@/lib/ai-fields/types";
import {
  aiFieldEditImpact,
  aiFieldStats,
  checkFieldAgain,
  hiddenAiFields,
  listAiFields,
  removeAiField,
  saveAiField,
  scopeCounts,
  setAiFieldHidden,
  setAiFieldPaused,
  showRuleAsColumn,
  spendThisMonth,
} from "@/lib/ai-fields/fields";
import { cleanManualValue, getAnswer, getCompanyAnswers, markCompanyDue, revertToWebAnswer, setManualAnswer } from "@/lib/ai-fields/answers";
import { storedNumber } from "@/lib/ai-fields/cells";
import { bestExcerpt, checkNowMessage, COMPANIES_PER_RUN, decisionBatches, decisionQuestions, looseNumber, readDecision, runAiFields } from "@/lib/ai-fields/runner";
import { eventTriggerTypes } from "@/lib/workflows/definition";
import { createAgent, createUser, queryAsUser, resetDatabase } from "./helpers";
import { GET as listCompaniesRoute } from "@/app/api/v1/companies/route";
import { listRecentChanges } from "@/lib/crm/undo";

const ENV = { PARALLEL_API_KEY: "par_test" };

type Sent = { url: string; method: string; body: Record<string, unknown> | null; headers: Record<string, string> };

type FakeOptions = {
  decide?: (body: { state: Record<string, unknown>; questions: Record<string, { type: string; instructions: string; criteria?: unknown }> }) => Record<string, unknown> | Response;
  task?: (input: Record<string, unknown>, schema: { properties: Record<string, unknown> }) => { content: Record<string, unknown>; basis?: unknown[] };
  status?: (runId: string) => string;
};

function fakeParallel(options: FakeOptions = {}) {
  const sent: Sent[] = [];
  const runs = new Map<string, { input: Record<string, unknown>; schema: { properties: Record<string, unknown> } }>();
  let count = 0;
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ url, method, body, headers: (init.headers ?? {}) as Record<string, string> });
    if (url === "https://api.parallel.ai/v1/decisions") {
      const reply = options.decide?.(body as never) ?? { answers: {}, citations: [] };
      return reply instanceof Response ? reply : Response.json(reply);
    }
    if (url === "https://api.parallel.ai/v1/tasks/runs" && method === "POST") {
      count += 1;
      const runId = `trun_${count}`;
      const spec = (body?.task_spec as { output_schema: { json_schema: { properties: Record<string, unknown> } } }).output_schema.json_schema;
      runs.set(runId, { input: body?.input as Record<string, unknown>, schema: spec });
      return Response.json({ run_id: runId, interaction_id: runId, status: "queued", is_active: true, processor: "base", created_at: null, modified_at: null }, { status: 202 });
    }
    const match = url.match(/\/v1\/tasks\/runs\/([^/?]+)(\/result)?/);
    if (match) {
      const runId = decodeURIComponent(match[1]);
      const run = runs.get(runId);
      if (!run) return Response.json({ type: "error", error: { message: "Run failed or run id not found" } }, { status: 404 });
      const status = options.status?.(runId) ?? "completed";
      const active = status === "queued" || status === "running";
      if (!match[2]) return Response.json({ run_id: runId, status, is_active: active, processor: "base", error: status === "failed" ? { ref_id: "x", message: "It broke." } : null });
      if (active) return Response.json({ type: "error", error: { message: "Request timed out; run still active" } }, { status: 408 });
      const output = options.task?.(run.input, run.schema) ?? { content: {} };
      return Response.json({ run: { run_id: runId, status: "completed", is_active: false }, output: { type: "json", content: output.content, basis: output.basis ?? [] } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { sent, fetchImpl, runs };
}

function noul(value: number) {
  return { type: "noul", noul: value };
}

const SOON = () => Date.now() + 30_000;

function forbidden(error: unknown) {
  assert.ok(error instanceof CrmError);
  assert.equal(error.status, 403);
  assert.match(error.message, /owners and admins/);
  return true;
}

async function answerRow(fieldId: string, companyId: string) {
  return (
    await getAdminPool().query<{ state: string; value_bool: boolean | null; value_number: string | null; next_check_at: Date | null; checked_at: Date | null; manual: boolean; run_id: string | null }>(
      "select state, value_bool, value_number, next_check_at, checked_at, manual, run_id from crm.ai_field_answers where field_id = $1 and company_id = $2",
      [fieldId, companyId],
    )
  ).rows[0];
}

describe("AI fields", () => {
  let owner: UserActor;
  let member: UserActor;
  let northlight: string;
  let copper: string;
  let bare: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@aifields.test", "Mark Ridgeon");
    const sam = (await getAdminPool().query<{ id: string }>("select private.create_local_user('sam@aifields.test', 'password-123', 'Sam Colleague') as id")).rows[0].id;
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, sam]);
    member = { ...owner, userId: sam, email: "sam@aifields.test", fullName: "Sam Colleague", role: "member", scopes: scopesForRole("member") };
    northlight = (await createCompany(owner, { name: "Northlight SEO", domain: "northlight.test", lifecycle: "prospect" })).body.company.id;
    copper = (await createCompany(owner, { name: "Copperleaf Media", domain: "copperleaf.test", sizeCategory: "51-200" })).body.company.id;
    bare = (await createCompany(owner, { name: "No Website Ltd" })).body.company.id;
  });

  it("works out the cost hint before saving", () => {
    const pick = costHint("pick", 61, "monthly");
    assert.equal(pick.text, "About $0.06 to fill, then about $0.06 a month.");
    assert.equal("note" in pick, false);
    const staff = costHint("number", 214, "monthly");
    assert.equal(staff.text, "About $2.14 to fill, then about $2.14 a month.");
    assert.equal(costHint("yes_no", 300, "weekly").text, "About $0.30 to fill, then about $1.30 a month.");
    assert.equal(costHint("text", 1, "manual").text, "About $0.01 to fill.");
    assert.equal(costHint("yes_no", 3, "monthly").text, "Under $0.01 to fill, then under $0.01 a month.");
  });

  it("only lets owners and admins manage fields and views", async () => {
    await assert.rejects(saveAiField(member, { label: "Sells GEO", question: "Does this agency sell GEO work?", kind: "yes_no" }), forbidden);
    await assert.rejects(createCompanyView(member, { name: "Mine", params: "lifecycle=prospect" }), forbidden);
    await assert.rejects(saveAiField(owner, { label: "Sells GEO", question: "GEO?", kind: "yes_no" }), /10 to 1,000/);
    await assert.rejects(saveAiField(owner, { label: "Agency type", question: "Which type of agency is this?", kind: "pick", options: ["SEO"] }), /two options/);
    await assert.rejects(saveAiField(owner, { label: "Agency type", question: "Which type of agency is this?", kind: "pick", options: ["SEO", "PR|Comms"] }), /\|/);
    const field = await saveAiField(owner, { label: "Sells GEO", question: "Does this agency sell GEO or AI search visibility work to its clients?", kind: "yes_no" });
    await assert.rejects(saveAiField(owner, { label: "sells geo", question: "Does it sell GEO work at all?", kind: "yes_no" }), /sells geo already exists\./);
    await assert.rejects(removeAiField(member, field.id), forbidden);
    await assert.rejects(setAiFieldPaused(member, field.id, true), forbidden);
    await assert.rejects(setManualAnswer(member, field.id, northlight, "yes"), forbidden);
    await assert.rejects(checkFieldAgain(member, field.id), forbidden);
    const memberView = await listAiFields(member);
    assert.deepEqual(memberView.map((item) => item.label), ["Sells GEO"]);
    const sneaky = await getAdminPool().query("select count(*)::int as total from crm.ai_fields");
    assert.equal(sneaky.rows[0].total, 1);
    await removeAiField(owner, field.id);
  });

  it("asks every yes/no and pick-list field about a company in one Decisions request and applies the thresholds", async () => {
    const geo = await saveAiField(owner, { label: "Sells GEO", question: "Does this agency sell GEO or AI search visibility work to its clients?", kind: "yes_no" });
    const type = await saveAiField(owner, { label: "Agency type", question: "Which type of agency is this?", kind: "pick", options: ["SEO", "PR", "Content", "Other"] });
    const channels = await saveAiField(owner, { label: "Channels", question: "Which channels does it sell?", kind: "pick", options: ["Search", "Social", "Email"], multiple: true });
    const { questions, used } = decisionQuestions([geo, type, channels]);
    assert.equal(used.length, 3);
    assert.deepEqual(Object.keys(questions), ["q0", "q1", "q2_o0", "q2_o1", "q2_o2"]);
    assert.deepEqual(questions.q1.type === "choice" && Object.keys(questions.q1.criteria), ["o0", "o1", "o2", "o3", "unknown"]);
    const citations = [{ url: "https://northlight.test/services", title: "Services", excerpts: ["Menu. We help brands get cited in AI search visibility tools like ChatGPT. Contact us."] }];
    const decide = (yes: number) => ({ answers: { q0: noul(yes) }, citations });
    assert.equal(readDecision(geo, 0, decide(0.94) as never).bool, true);
    assert.equal(readDecision(geo, 0, decide(0.85) as never).state, "answered");
    assert.equal(readDecision(geo, 0, decide(0.84) as never).state, "unknown");
    assert.equal(readDecision(geo, 0, decide(0.16) as never).state, "unknown");
    const no = readDecision(geo, 0, decide(0.15) as never);
    assert.equal(no.bool, false);
    assert.ok(Math.abs((no.likelihood ?? 0) - 0.85) < 1e-9);
    const yes = readDecision(geo, 0, decide(0.94) as never);
    assert.equal(yes.reason, "We help brands get cited in AI search visibility tools like ChatGPT.");
    assert.deepEqual(yes.sources, [{ title: "Services", url: "https://northlight.test/services" }]);
    const pick = (choice: string, p: number) => ({ answers: { q1: { type: "choice", choice, probabilities: { [choice]: p } } }, citations: [] });
    assert.deepEqual(readDecision(type, 1, pick("o0", 0.7) as never).options, ["SEO"]);
    assert.equal(readDecision(type, 1, pick("o0", 0.69) as never).state, "unknown");
    assert.equal(readDecision(type, 1, pick("unknown", 0.9) as never).state, "unknown");
    const multi = readDecision(channels, 2, { answers: { q2_o0: noul(0.9), q2_o1: noul(0.5), q2_o2: noul(0.72) }, citations: [] } as never);
    assert.deepEqual(multi.options, ["Search", "Email"]);
    assert.equal(bestExcerpt([], "anything"), null);

    const api = fakeParallel({
      decide: (body) => {
        const company = body.state.company;
        if (company === "Northlight SEO") return { answers: { q0: noul(0.94), q1: { type: "choice", choice: "o0", probabilities: { o0: 0.88 } }, q2_o0: noul(0.9), q2_o1: noul(0.1), q2_o2: noul(0.1) }, citations };
        return { answers: { q0: noul(0.5), q1: { type: "choice", choice: "o1", probabilities: { o1: 0.6 } }, q2_o0: noul(0.1), q2_o1: noul(0.1), q2_o2: noul(0.1) }, citations: [] };
      },
    });
    const report = await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(report.error, undefined);
    const decisions = api.sent.filter((item) => item.url.endsWith("/decisions"));
    assert.equal(decisions.length, 2);
    assert.ok(decisions.every((item) => Object.keys((item.body as { questions: object }).questions).length === 5));
    assert.ok(!JSON.stringify(decisions).includes("No Website Ltd"));
    const { answers } = await getCompanyAnswers(owner, northlight);
    const byField = Object.fromEntries(answers.map((answer) => [answer.fieldId, answer]));
    assert.equal(byField[geo.id].value, true);
    assert.equal(byField[geo.id].likelihood, 0.94);
    assert.deepEqual(byField[type.id].value, ["SEO"]);
    assert.deepEqual(byField[channels.id].value, ["Search"]);
    const copperAnswers = Object.fromEntries((await getCompanyAnswers(owner, copper)).answers.map((answer) => [answer.fieldId, answer]));
    assert.equal(copperAnswers[geo.id].state, "unknown");
    assert.equal(copperAnswers[type.id].state, "unknown");
    const outside = Object.fromEntries((await getCompanyAnswers(owner, bare)).answers.map((answer) => [answer.fieldId, answer]));
    assert.equal(outside[geo.id].state, "outside");
    const spent = await spendThisMonth(owner);
    assert.equal(spent.decisions, 2);
    const again = await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(again.checked, 0);
    await removeAiField(owner, channels.id);
    await removeAiField(owner, type.id);
    await removeAiField(owner, geo.id);
  });

  it("talks to the Task API: create, poll, read the result, and handle failures", async () => {
    const api = fakeParallel({ task: () => ({ content: { staff: 14 }, basis: [{ field: "staff", citations: [{ url: "https://a.test/team", title: "Team", excerpts: ["We are a team of 14 people."] }], reasoning: "Team page.", confidence: "high" }] }) });
    const run = await createTaskRun({ company: "Acme" }, { staff: { type: "number", description: "How many staff?" } }, { fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(run.runId, "trun_1");
    assert.equal(run.status, "queued");
    const posted = api.sent[0];
    assert.equal(posted.url, "https://api.parallel.ai/v1/tasks/runs");
    assert.equal(posted.headers["x-api-key"], "par_test");
    assert.equal(posted.body?.processor, "base");
    assert.deepEqual((posted.body?.task_spec as { output_schema: unknown }).output_schema, {
      type: "json",
      json_schema: { type: "object", properties: { staff: { type: ["number", "null"], description: "How many staff?" } }, required: ["staff"], additionalProperties: false },
    });
    assert.deepEqual(taskJsonSchema({ a: { type: "string", description: "A" } }).required, ["a"]);
    const status = await getTaskRun(run.runId, { fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(status?.status, "completed");
    const result = await getTaskResult(run.runId, { fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(result?.content.staff, 14);
    assert.equal(result?.basis[0].confidence, "high");
    assert.match(api.sent[2].url, /\/v1\/tasks\/runs\/trun_1\/result\?timeout=5$/);
    const waiting = fakeParallel({ status: () => "running" });
    const queued = await createTaskRun({ company: "Acme" }, { staff: { type: "number", description: "Staff?" } }, { fetchImpl: waiting.fetchImpl, env: ENV });
    assert.equal(await getTaskResult(queued.runId, { fetchImpl: waiting.fetchImpl, env: ENV }), null);
    const denied = (async () => new Response("no", { status: 402 })) as typeof fetch;
    await assert.rejects(createTaskRun({ company: "Acme" }, { staff: { type: "number", description: "Staff?" } }, { fetchImpl: denied, env: ENV }), /out of credit/);
    await assert.rejects(createTaskRun({}, { a: { type: "string", description: "x".repeat(16_000) } }, { fetchImpl: api.fetchImpl, env: ENV }), /too long/);
    const offline = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    assert.equal(await getTaskRun("trun_x", { fetchImpl: offline, env: ENV }), null);
  });

  it("fills number and short text fields with one Task run per company, collecting it on a later tick", async () => {
    const staff = await saveAiField(owner, { label: "Staff", question: "How many people work at this agency?", kind: "number" });
    assert.equal(staff.fillsSize, true);
    const city = await saveAiField(owner, { label: "City", question: "Which city is the head office in?", kind: "text" });
    assert.equal(city.fillsSize, false);
    let status = "running";
    const api = fakeParallel({
      status: () => status,
      task: (input, schema) => {
        const keys = Object.keys(schema.properties);
        const staffKey = keys.find((key) => key.includes(staff.id.replace(/-/g, "")))!;
        const cityKey = keys.find((key) => key.includes(city.id.replace(/-/g, "")))!;
        const name = input.company;
        return {
          content: { [staffKey]: name === "Northlight SEO" ? 14 : "about 64", [cityKey]: name === "Northlight SEO" ? "Leeds" : null },
          basis: [
            { field: staffKey, citations: [{ url: "https://n.test/about", title: "About", excerpts: ["Our team of 14 works from Leeds."] }], confidence: name === "Northlight SEO" ? "high" : "low" },
            { field: cityKey, citations: [], confidence: "medium" },
          ],
        };
      },
    });
    const first = await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(first.started, 2);
    const created = api.sent.filter((item) => item.method === "POST" && item.url.endsWith("/tasks/runs"));
    assert.equal(created.length, 2);
    assert.equal(Object.keys((created[0].body?.task_spec as { output_schema: { json_schema: { properties: object } } }).output_schema.json_schema.properties).length, 2);
    assert.ok((await answerRow(staff.id, northlight)).run_id);
    assert.equal((await getAnswer(owner, staff.id, northlight)).answer.state, "checking");

    const stillRunning = await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(stillRunning.collected, 0);
    assert.equal(stillRunning.started, 0);
    assert.ok((await answerRow(staff.id, northlight)).run_id);

    status = "completed";
    const later = await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(later.collected, 2);
    const north = await getAnswer(owner, staff.id, northlight);
    assert.equal(north.answer.value, 14);
    assert.equal(north.answer.confidence, "high");
    assert.equal(north.answer.reason, "Our team of 14 works from Leeds.");
    assert.equal((await getAnswer(owner, city.id, northlight)).answer.value, "Leeds");
    assert.equal((await getAnswer(owner, staff.id, copper)).answer.state, "unknown");
    assert.equal((await getAnswer(owner, city.id, copper)).answer.state, "unknown");
    assert.equal((await answerRow(staff.id, northlight)).run_id, null);
    assert.equal((await spendThisMonth(owner)).tasks, 2);

    const northCompany = await getCompany(owner, northlight);
    assert.equal(northCompany.sizeCategory, "11-50");
    assert.equal((await getCompany(owner, copper)).sizeCategory, "51-200");

    const broken = fakeParallel({ status: () => "failed" });
    await checkFieldAgain(owner, staff.id);
    await runAiFields(owner, { deadline: SOON(), fetchImpl: broken.fetchImpl, env: ENV });
    await runAiFields(owner, { deadline: SOON(), fetchImpl: broken.fetchImpl, env: ENV });
    const failed = await answerRow(staff.id, northlight);
    assert.equal(failed.run_id, null);
    assert.equal(failed.value_number, "14");
    assert.ok(failed.next_check_at && new Date(failed.next_check_at).getTime() > Date.now() + 5 * 3_600_000);
    await removeAiField(owner, city.id);
  });

  it("fills Size only when it's empty and only for fields that fill it", async () => {
    const fields = await listAiFields(owner);
    const staff = fields.find((field) => field.label === "Staff")!;
    assert.equal(looksLikeStaff("Staff", "How many?"), true);
    assert.equal(looksLikeStaff("Revenue", "How much revenue does it make?"), false);
    assert.deepEqual([1, 10, 11, 50, 51, 200, 1000, 1001, 0].map(sizeForStaff), ["1-10", "1-10", "11-50", "11-50", "51-200", "51-200", "201-1000", "1000+", null]);
    const empty = (await createCompany(owner, { name: "Kite and Co", domain: "kite.test" })).body.company.id;
    await setManualAnswer(owner, staff.id, empty, 29);
    assert.equal((await getCompany(owner, empty)).sizeCategory, "11-50");
    await setManualAnswer(owner, staff.id, empty, 600);
    assert.equal((await getCompany(owner, empty)).sizeCategory, "11-50");
    const other = await saveAiField(owner, { label: "Offices", question: "How many offices does it have?", kind: "number", fillsSize: false });
    const plain = (await createCompany(owner, { name: "Plain Co", domain: "plain.test" })).body.company.id;
    await setManualAnswer(owner, other.id, plain, 3);
    assert.equal((await getCompany(owner, plain)).sizeCategory, null);
    await removeAiField(owner, other.id);
  });

  it("never overwrites or re-checks an answer set by hand, and Use web answer brings the web one back", async () => {
    const geo = await saveAiField(owner, { label: "Sells GEO", question: "Does this agency sell GEO or AI search visibility work to its clients?", kind: "yes_no" });
    const yes = fakeParallel({ decide: () => ({ answers: { q0: noul(0.95) }, citations: [{ url: "https://n.test/geo", title: "GEO", excerpts: ["We sell AI search visibility work."] }] }) });
    await runAiFields(owner, { deadline: SOON(), fetchImpl: yes.fetchImpl, env: ENV });
    assert.equal((await getAnswer(owner, geo.id, northlight)).answer.value, true);
    const manual = await setManualAnswer(owner, geo.id, northlight, "no");
    assert.equal(manual.answer.value, false);
    assert.equal(manual.answer.manual, true);
    assert.equal(manual.answer.web?.value, true);
    assert.equal(manual.answer.web?.likelihood, 0.95);
    await checkFieldAgain(owner, geo.id);
    const again = fakeParallel({ decide: () => ({ answers: { q0: noul(0.99) }, citations: [] }) });
    await runAiFields(owner, { deadline: SOON(), fetchImpl: again.fetchImpl, env: ENV });
    const asked = again.sent.filter((item) => item.url.endsWith("/decisions")).map((item) => (item.body as { state: { company: string } }).state.company);
    assert.ok(!asked.includes("Northlight SEO"));
    const kept = await answerRow(geo.id, northlight);
    assert.equal(kept.value_bool, false);
    assert.equal(kept.manual, true);
    assert.equal(kept.next_check_at, null);
    const saveTried = await getAdminPool().query("select private.ai_field_save($1, $2, $3, $4::jsonb) as change", [owner.workspaceId, geo.id, northlight, JSON.stringify({ state: "answered", bool: true })]);
    assert.equal(saveTried.rows[0].change, null);
    assert.equal((await answerRow(geo.id, northlight)).value_bool, false);
    const restored = await revertToWebAnswer(owner, geo.id, northlight);
    assert.equal(restored.answer.value, true);
    assert.equal(restored.answer.manual, false);
    assert.equal(restored.answer.likelihood, 0.95);
    await removeAiField(owner, geo.id);
  });

  it("saves a blank number answer as Unknown and keeps a real 0", async () => {
    const field = { kind: "number" as const, options: [], multiple: false };
    for (const blank of [null, undefined, "", "   ", "\t\n"]) {
      assert.deepEqual(cleanManualValue(field, blank), { state: "unknown", bool: null, number: null, text: null, options: null }, JSON.stringify(blank));
    }
    assert.equal(cleanManualValue(field, 0).number, 0);
    assert.equal(cleanManualValue(field, "0").number, 0);
    assert.equal(cleanManualValue(field, " 1,200 ").number, 1200);
    for (const wrong of [",", true, [], {}, "abc"]) {
      assert.throws(() => cleanManualValue(field, wrong), /Enter a number/, JSON.stringify(wrong));
    }
    assert.equal(cleanManualValue({ kind: "yes_no", options: [], multiple: false }, "  ").state, "unknown");
    assert.equal(storedNumber(""), null);
    assert.equal(storedNumber("  "), null);
    assert.equal(storedNumber(null), null);
    assert.equal(storedNumber("0"), 0);
    assert.equal(storedNumber(0), 0);
    for (const raw of [null, "", "   ", "unknown"]) assert.equal(looseNumber(raw), null, JSON.stringify(raw));
    assert.equal(looseNumber(0), 0);
    assert.equal(looseNumber("0"), 0);

    const staff = await saveAiField(owner, { label: "Writers", question: "How many writers does it employ?", kind: "number", fillsSize: false });
    const blank = await setManualAnswer(owner, staff.id, northlight, "   ");
    assert.equal(blank.answer.state, "unknown");
    assert.equal(blank.answer.value, null);
    assert.equal((await answerRow(staff.id, northlight)).value_number, null);
    const zero = await setManualAnswer(owner, staff.id, northlight, "0");
    assert.equal(zero.answer.state, "answered");
    assert.equal(zero.answer.value, 0);
    const cleared = await setManualAnswer(owner, staff.id, northlight, null);
    assert.equal(cleared.answer.state, "unknown");
    assert.equal(cleared.answer.value, null);
    await removeAiField(owner, staff.id);
  });

  it("records answer changes as audit events that start field changed workflows", async () => {
    const geo = await saveAiField(owner, { label: "Sells GEO", question: "Does this agency sell GEO or AI search visibility work to its clients?", kind: "yes_no" });
    assert.deepEqual(eventTriggerTypes("company.ai_field_changed", "company", {}), ["field_changed"]);
    const api = fakeParallel({ decide: () => ({ answers: { q0: noul(0.9) }, citations: [] }) });
    await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV });
    const admin = getAdminPool();
    const events = await admin.query<{ entity_id: string; source: string | null; operation: string; changes: { fields: string[]; before: Record<string, unknown>; after: Record<string, unknown> } }>(
      "select entity_id, source, operation, changes from crm.audit_events where event_type = 'company.ai_field_changed' and changes->'aiField'->>'id' = $1 order by created_at",
      [geo.id],
    );
    const key = `ai:${geo.id}`;
    const north = events.rows.find((row) => row.entity_id === northlight)!;
    assert.deepEqual(north.changes.fields, [key]);
    assert.equal(north.changes.before[key], null);
    assert.equal(north.changes.after[key], "Yes");
    assert.equal(north.source, "parallel");
    const queued = await admin.query<{ trigger_types: string[] }>(
      "select trigger_types from crm.workflow_events where entity_id = $1 and event_type = 'company.ai_field_changed' and data->'aiField'->>'id' = $2",
      [northlight, geo.id],
    );
    assert.equal(queued.rows.length, 1);
    assert.ok(queued.rows[0].trigger_types.includes("field_changed"));
    const before = events.rows.length;
    await checkFieldAgain(owner, geo.id);
    await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV });
    const unchanged = await admin.query("select count(*)::int as total from crm.audit_events where event_type = 'company.ai_field_changed' and changes->'aiField'->>'id' = $1", [geo.id]);
    assert.equal(unchanged.rows[0].total, before);
    await setManualAnswer(owner, geo.id, northlight, "no");
    const manual = await admin.query<{ operation: string; actor_user_id: string; changes: { after: Record<string, unknown> } }>(
      "select operation, actor_user_id, changes from crm.audit_events where event_type = 'company.ai_field_changed' and entity_id = $1 order by created_at desc limit 1",
      [northlight],
    );
    assert.equal(manual.rows[0].operation, "ai_field_manual");
    assert.equal(manual.rows[0].changes.after[key], "No");
    const timeline = await admin.query("select count(*)::int as total from crm.activities where company_id = $1", [northlight]);
    assert.equal(timeline.rows[0].total, 0);
    await removeAiField(owner, geo.id);
  });

  it("keeps to the refresh schedule and pauses when not kept up to date", async () => {
    const monthly = await saveAiField(owner, { label: "Hiring", question: "Is the company hiring right now?", kind: "yes_no", refresh: "monthly" });
    const weekly = await saveAiField(owner, { label: "News", question: "Has the company been in the news this week?", kind: "yes_no", refresh: "weekly" });
    const manual = await saveAiField(owner, { label: "Remote", question: "Does the company work fully remote?", kind: "yes_no", refresh: "manual" });
    const fieldIds = [monthly.id, weekly.id, manual.id];
    const api = fakeParallel({ decide: (body) => ({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, noul(0.9)])), citations: [] }) });
    await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV, fieldIds });
    const days = (row: { next_check_at: Date | null; checked_at: Date | null }) => Math.round((new Date(row.next_check_at!).getTime() - new Date(row.checked_at!).getTime()) / 86_400_000);
    assert.equal(days(await answerRow(monthly.id, northlight)), 30);
    assert.equal(days(await answerRow(weekly.id, northlight)), 7);
    assert.equal((await answerRow(manual.id, northlight)).next_check_at, null);
    const sentBefore = api.sent.length;
    await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV, fieldIds });
    assert.equal(api.sent.length, sentBefore);
    await getAdminPool().query("update crm.ai_field_answers set next_check_at = now() - interval '1 minute' where field_id = $1", [weekly.id]);
    await setAiFieldPaused(owner, weekly.id, true);
    await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV, fieldIds });
    assert.equal(api.sent.length, sentBefore);
    await setAiFieldPaused(owner, weekly.id, false);
    await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV, fieldIds });
    const asked = api.sent.slice(sentBefore).map((item) => Object.keys((item.body as { questions: object }).questions).length);
    assert.ok(asked.length > 0 && asked.every((count) => count === 1));
    const fresh = (await createCompany(owner, { name: "Fresh Co", domain: "fresh.test" })).body.company.id;
    await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV, fieldIds });
    assert.equal((await answerRow(manual.id, fresh)).state, "answered");
    for (const field of [monthly, weekly, manual]) await removeAiField(owner, field.id);
  });

  it("checks only the companies in the field's scope: all, a saved view, or good ICP fit", async () => {
    await saveEnrichmentSettings(owner, { webIcp: true, icpText: "UK SEO agencies" });
    const hash = icpHashOf("UK SEO agencies");
    const admin = getAdminPool();
    await admin.query(
      `insert into crm.company_web_state (company_id, workspace_id, icp_score, icp_hash, icp_checked_at) values ($1, $3, 3.6, $4, now()), ($2, $3, 1.9, $4, now())
       on conflict (company_id) do update set icp_score = excluded.icp_score, icp_hash = excluded.icp_hash, icp_checked_at = now()`,
      [northlight, copper, owner.workspaceId, hash],
    );
    const prospects = await createCompanyView(owner, { name: "Prospects", params: "?lifecycle=prospect&page=2" });
    assert.equal(prospects.params, "lifecycle=prospect");
    const fit = await saveAiField(owner, { label: "Fit thing", question: "Is this a fit for our content work?", kind: "yes_no", scope: "fit" });
    const view = await saveAiField(owner, { label: "View thing", question: "Is this a prospect worth calling?", kind: "yes_no", scope: "view", scopeViewId: prospects.id });
    await assert.rejects(saveAiField(owner, { label: "No view", question: "Is this missing a view?", kind: "yes_no", scope: "view" }), /saved view/);
    const counts = await scopeCounts(owner);
    assert.equal(counts.fit, 1);
    assert.equal(counts.views[prospects.id], 1);
    assert.ok(counts.all >= 4);
    const api = fakeParallel({ decide: (body) => ({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, noul(0.9)])), citations: [] }) });
    await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV, fieldIds: [fit.id, view.id] });
    const asked = api.sent.map((item) => (item.body as { state: { company: string } }).state.company);
    assert.deepEqual(asked, ["Northlight SEO"]);
    assert.equal((await getAnswer(owner, fit.id, copper)).answer.state, "outside");
    const stats = await aiFieldStats(owner);
    const fitStats = stats.find((item) => item.fieldId === fit.id)!;
    assert.deepEqual([fitStats.total, fitStats.answered], [1, 1]);
    await assert.rejects(deleteCompanyView(owner, prospects.id), /View thing uses this view/);
    await removeAiField(owner, fit.id);
    await removeAiField(owner, view.id);
    await saveEnrichmentSettings(owner, { webIcp: false });
  });

  it("filters and sorts companies by AI fields and round-trips them through the URL", async () => {
    const staff = (await listAiFields(owner)).find((field) => field.label === "Staff")!;
    const geo = await saveAiField(owner, { label: "Sells GEO", question: "Does this agency sell GEO or AI search visibility work to its clients?", kind: "yes_no" });
    const type = await saveAiField(owner, { label: "Agency type", question: "Which type of agency is this?", kind: "pick", options: ["SEO", "PR", "Content", "Other"] });
    await setManualAnswer(owner, geo.id, northlight, "yes");
    await setManualAnswer(owner, geo.id, copper, "no");
    await setManualAnswer(owner, staff.id, copper, 64);
    await setManualAnswer(owner, type.id, northlight, ["SEO"]);
    await setManualAnswer(owner, type.id, copper, "Content");

    const params = new URLSearchParams();
    params.set(aiParamKey(geo.id), aiFilterValue({ fieldId: geo.id, op: "is", value: "yes" }));
    params.set(aiParamKey(staff.id), aiFilterValue({ fieldId: staff.id, op: "range", min: 5, max: 30, unknown: false }));
    params.set(aiParamKey(type.id), aiFilterValue({ fieldId: type.id, op: "any", options: ["SEO", "Content"], unknown: true }));
    params.set("sort", aiSortValue(staff.id));
    params.set("order", "asc");
    const parsed = companyQueryFromSearchParams(params);
    assert.equal(parsed.aiSort, staff.id);
    assert.equal(parsed.ai?.length, 3);
    const again = new URLSearchParams();
    for (const filter of parsed.ai ?? []) again.set(aiParamKey(filter.fieldId), aiFilterValue(filter));
    assert.deepEqual(aiFiltersFromParams(again), parsed.ai);
    assert.deepEqual(parseAiFilter(staff.id, "range:..30|?"), { fieldId: staff.id, op: "range", min: null, max: 30, unknown: true });
    assert.equal(parseAiFilter(staff.id, "range:abc..3"), null);
    assert.equal(parseAiFilter("not-a-uuid", "is:yes"), null);
    assert.equal(parseAiFilter(geo.id, "is:maybe"), null);

    const listed = await listCompanies(owner, { ...parsed, aiFields: true });
    assert.deepEqual(listed.data.map((company) => company.name), ["Northlight SEO"]);
    assert.equal(listed.data[0].aiFields?.[geo.id].value, true);
    assert.equal(listed.data[0].aiFields?.[geo.id].manual, true);

    const unknownGeo = await listCompanies(owner, { ai: [{ fieldId: geo.id, op: "is", value: "unknown" }] });
    assert.ok(!unknownGeo.data.some((company) => company.name === "Northlight SEO" || company.name === "Copperleaf Media"));
    const contains = await listCompanies(owner, { ai: [{ fieldId: type.id, op: "has", text: "cont" }] });
    assert.deepEqual(contains.data.map((company) => company.name), ["Copperleaf Media"]);
    const withUnknown = await listCompanies(owner, { ai: [{ fieldId: staff.id, op: "range", min: 50, max: null, unknown: true }] });
    assert.ok(withUnknown.data.some((company) => company.name === "Copperleaf Media"));
    assert.ok(!withUnknown.data.some((company) => company.name === "Northlight SEO"));

    const sorted = await listCompanies(owner, { aiSort: staff.id, order: "desc" });
    assert.deepEqual(sorted.data.slice(0, 2).map((company) => company.name), ["Kite and Co", "Copperleaf Media"]);
    const ascending = await listCompanies(owner, { aiSort: staff.id, order: "asc" });
    assert.equal(ascending.data[0].name, "Northlight SEO");
    assert.equal(ascending.data.at(-1)?.aiFields, undefined);

    const csv = companiesCsvRows((await listCompanies(owner, { aiFields: true, sort: "name" })).data, [geo, type, staff]);
    assert.deepEqual(csv[0].slice(-3), ["Sells GEO", "Agency type", "Staff"]);
    const copperRow = csv.find((row) => row[0] === "Copperleaf Media")!;
    assert.deepEqual(copperRow.slice(-3), ["No", "Content", "64"]);
    const bareRow = csv.find((row) => row[0] === "No Website Ltd")!;
    assert.deepEqual(bareRow.slice(-3), ["", "", ""]);
    await removeAiField(owner, type.id);
    await removeAiField(owner, geo.id);
  });

  it("shares saved views with the workspace and only lets owners and admins change them", async () => {
    const view = await createCompanyView(owner, { name: "GEO prospects", params: `lifecycle=prospect&${aiParamKey("3f0e2c1a-0000-4000-8000-000000000000")}=is:yes&view=abc` });
    assert.ok(!view.params.includes("view="));
    await assert.rejects(createCompanyView(owner, { name: "geo prospects", params: "" }), /geo prospects already exists/);
    await assert.rejects(createCompanyView(owner, { name: "All companies", params: "" }), /Choose another name/);
    const seen = await listCompanyViews(member);
    assert.ok(seen.some((item) => item.id === view.id));
    await assert.rejects(updateCompanyView(member, view.id, { name: "Mine" }), forbidden);
    await assert.rejects(deleteCompanyView(member, view.id), forbidden);
    const renamed = await updateCompanyView(owner, view.id, { name: "GEO leads" });
    assert.equal(renamed.name, "GEO leads");
    assert.equal(renamed.params, view.params);
    const direct = await getAdminPool().query("select count(*)::int as total from crm.company_views where workspace_id = $1", [owner.workspaceId]);
    assert.ok(direct.rows[0].total >= 2);
    await deleteCompanyView(owner, view.id);
    assert.ok(!(await listCompanyViews(owner)).some((item) => item.id === view.id));
  });

  it("hides columns per person and turns tag rules into yes/no columns", async () => {
    const staff = (await listAiFields(owner)).find((field) => field.label === "Staff")!;
    await setAiFieldHidden(member, staff.id, true);
    assert.deepEqual(await hiddenAiFields(member), [staff.id]);
    assert.deepEqual(await hiddenAiFields(owner), []);
    await setAiFieldHidden(member, staff.id, false);
    assert.deepEqual(await hiddenAiFields(member), []);
    const rule = await saveWebCheck(owner, { kind: "tag", label: "agency", question: "Is the company a marketing, content or SEO agency?" });
    const column = await showRuleAsColumn(owner, rule.id);
    assert.equal(column.kind, "yes_no");
    assert.equal(column.label, "Agency");
    assert.equal(column.question, rule.question);
    assert.equal(column.webCheckId, rule.id);
    assert.equal((await showRuleAsColumn(owner, rule.id)).id, column.id);
    await assert.rejects(showRuleAsColumn(member, rule.id), forbidden);
    const rules = await getAdminPool().query("select count(*)::int as total from crm.web_checks where id = $1", [rule.id]);
    assert.equal(rules.rows[0].total, 1);
    await removeAiField(owner, column.id);
  });

  it("does nothing without a key and stops on a rejected key", async () => {
    const skipped = await runAiFields(owner, { deadline: SOON(), env: {} });
    assert.equal(skipped.skipped, "No PARALLEL_API_KEY.");
    const geo = await saveAiField(owner, { label: "Sells GEO", question: "Does this agency sell GEO or AI search visibility work to its clients?", kind: "yes_no" });
    const denied = fakeParallel({ decide: () => new Response("no", { status: 401 }) });
    const report = await runAiFields(owner, { deadline: SOON(), fetchImpl: denied.fetchImpl, env: ENV });
    assert.equal(report.error, "Parallel rejected the key.");
    assert.equal(denied.sent.filter((item) => item.url.endsWith("/decisions")).length, 1);
    const field = (await listAiFields(owner)).find((item) => item.id === geo.id)!;
    assert.equal(field.lastError, "Parallel rejected the key.");
    await removeAiField(owner, geo.id);
  });
});

describe("AI fields: edits, costs and failures", () => {
  let owner: UserActor;
  let member: UserActor;
  let alpha: string;
  let beta: string;
  let gamma: string;

  const yesToAll = (body: { questions: Record<string, unknown> }) => ({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, noul(0.95)])), citations: [] });
  const decisionsSent = (api: { sent: Sent[] }) => api.sent.filter((item) => item.url.endsWith("/decisions"));
  const removeAll = async () => {
    for (const field of await listAiFields(owner)) await removeAiField(owner, field.id);
  };

  before(async () => {
    await resetDatabase();
    owner = await createUser("owner@aifix.test", "Mark Ridgeon");
    const sam = (await getAdminPool().query<{ id: string }>("select private.create_local_user('member@aifix.test', 'password-123', 'Sam Colleague') as id")).rows[0].id;
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, sam]);
    member = { ...owner, userId: sam, email: "member@aifix.test", fullName: "Sam Colleague", role: "member", scopes: scopesForRole("member") };
    alpha = (await createCompany(owner, { name: "Alpha Agency", domain: "alpha.test", lifecycle: "prospect" })).body.company.id;
    beta = (await createCompany(owner, { name: "Beta Studio", domain: "beta.test" })).body.company.id;
    gamma = (await createCompany(owner, { name: "Gamma Group", domain: "gamma.test" })).body.company.id;
  });

  it("edits a field's type, options and question, keeping hand-set answers that still fit", async () => {
    const field = await saveAiField(owner, { label: "Agency type", question: "Which type of agency is this?", kind: "pick", options: ["SEO", "PR", "Content"] });
    const api = fakeParallel({ decide: () => ({ answers: { q0: { type: "choice", choice: "o0", probabilities: { o0: 0.9 } } }, citations: [] }) });
    await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV });
    assert.equal((await answerRow(field.id, alpha)).state, "answered");
    await setManualAnswer(owner, field.id, beta, "PR");
    await setManualAnswer(owner, field.id, gamma, "Content");

    const renamed = await saveAiField(owner, { id: field.id, label: "Agency type", question: "Which type of agency is this?", kind: "pick", options: ["seo", "pr", "Paid"] });
    assert.deepEqual(renamed.options, ["seo", "pr", "Paid"]);
    assert.equal(await answerRow(field.id, alpha), undefined);
    const kept = await getAnswer(owner, field.id, beta);
    assert.equal(kept.answer.manual, true);
    assert.deepEqual(kept.answer.value, ["pr"]);
    assert.equal(kept.answer.web, null);
    assert.equal(await answerRow(field.id, gamma), undefined);

    const again = fakeParallel({ decide: () => ({ answers: { q0: { type: "choice", choice: "o2", probabilities: { o2: 0.9 } } }, citations: [] }) });
    await runAiFields(owner, { deadline: SOON(), fetchImpl: again.fetchImpl, env: ENV });
    assert.deepEqual((await getAnswer(owner, field.id, alpha)).answer.value, ["Paid"]);
    assert.ok(!decisionsSent(again).some((item) => (item.body as { state: { company: string } }).state.company === "Beta Studio"));

    await setManualAnswer(owner, field.id, gamma, null);
    const yesNo = await saveAiField(owner, { id: field.id, label: "Agency type", question: "Is this an SEO agency at heart?", kind: "yes_no" });
    assert.equal(yesNo.kind, "yes_no");
    assert.equal(await answerRow(field.id, beta), undefined);
    assert.equal((await answerRow(field.id, gamma)).manual, true);
    assert.equal(await answerRow(field.id, alpha), undefined);

    await runAiFields(owner, { deadline: SOON(), fetchImpl: fakeParallel({ decide: yesToAll }).fetchImpl, env: ENV });
    const checkedAt = (await answerRow(field.id, alpha)).checked_at;
    assert.ok(checkedAt);
    await saveAiField(owner, { id: field.id, label: "Agency type", question: "Is this mainly an SEO agency?", kind: "yes_no" });
    const due = await answerRow(field.id, alpha);
    assert.equal(due.value_bool, true);
    assert.ok(due.next_check_at && new Date(due.next_check_at).getTime() <= Date.now());
    assert.equal((await answerRow(field.id, gamma)).manual, true);
    assert.deepEqual(await aiFieldEditImpact(owner, field.id), { web: 2, manual: 1 });

    const deleted = await queryAsUser(member.userId, "delete from crm.ai_field_answers where field_id = $1 returning company_id", [field.id]);
    assert.equal(deleted.length, 0);
    await removeAll();
  });

  it("filters by Unknown alone in the UI, the URL, the REST API and a saved view", async () => {
    const field = await saveAiField(owner, { label: "Agency type", question: "Which type of agency is this?", kind: "pick", options: ["SEO", "PR"] });
    await setManualAnswer(owner, field.id, alpha, "SEO");
    await setManualAnswer(owner, field.id, beta, null);
    const names = (data: { name: string }[]) => data.map((company) => company.name).sort();

    const ui = await listCompanies(owner, { ai: [{ fieldId: field.id, op: "any", options: [], unknown: true }] });
    assert.deepEqual(names(ui.data), ["Beta Studio", "Gamma Group"]);

    const params = new URLSearchParams(`${aiParamKey(field.id)}=any:?`);
    const fromUrl = companyQueryFromSearchParams(params);
    assert.deepEqual(fromUrl.ai, [{ fieldId: field.id, op: "any", options: [], unknown: true }]);
    assert.deepEqual(names((await listCompanies(owner, fromUrl)).data), ["Beta Studio", "Gamma Group"]);

    const { token } = await createAgent(owner.workspaceId, ["crm:read"]);
    const response = await listCompaniesRoute(new Request(`http://crm.test/api/v1/companies?${aiParamKey(field.id)}=any:%3F`, { headers: { authorization: `Bearer ${token}` } }));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: { name: string }[]; total: number };
    assert.equal(body.total, 2);
    assert.deepEqual(names(body.data), ["Beta Studio", "Gamma Group"]);

    const view = await createCompanyView(owner, { name: "Unknown type", params: `${aiParamKey(field.id)}=any:?` });
    const scoped = await saveAiField(owner, { label: "Unknown check", question: "Is this company hiring right now?", kind: "yes_no", scope: "view", scopeViewId: view.id });
    assert.equal((await scopeCounts(owner)).views[view.id], 2);
    const api = fakeParallel({ decide: yesToAll });
    await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV, fieldIds: [scoped.id] });
    assert.deepEqual(decisionsSent(api).map((item) => (item.body as { state: { company: string } }).state.company).sort(), ["Beta Studio", "Gamma Group"]);

    const stale = new URLSearchParams(`${aiParamKey("3f0e2c1a-0000-4000-8000-000000000000")}=is:unknown`);
    assert.equal((await listCompanies(owner, companyQueryFromSearchParams(stale))).total, 3);
    await removeAiField(owner, scoped.id);
    await deleteCompanyView(owner, view.id);
    await removeAll();
  });

  it("checks saved view filters when saving and treats an unreadable view as no companies", async () => {
    await assert.rejects(createCompanyView(owner, { name: "Broken", params: "owner=not-a-person" }), /invalid filter/);
    const view = await createCompanyView(owner, { name: "Prospects", params: "lifecycle=prospect" });
    const field = await saveAiField(owner, { label: "Hiring", question: "Is this company hiring right now?", kind: "yes_no", scope: "view", scopeViewId: view.id });
    await getAdminPool().query("update crm.company_views set params = 'owner=not-a-person' where id = $1", [view.id]);
    const counts = await scopeCounts(owner);
    assert.equal(counts.views[view.id], 0);
    const api = fakeParallel({ decide: yesToAll });
    const report = await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(report.error, undefined);
    assert.equal(decisionsSent(api).length, 0);
    assert.match((await listAiFields(owner))[0].lastError ?? "", /saved view has an invalid filter/);
    await removeAiField(owner, field.id);
    await deleteCompanyView(owner, view.id);
  });

  it("never pays twice when passes overlap or Check all again is pressed during a pass", async () => {
    const field = await saveAiField(owner, { label: "Hiring", question: "Is this company hiring right now?", kind: "yes_no" });
    let releaseFirst: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const sent: string[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init: RequestInit = {}) => {
      calls += 1;
      const body = JSON.parse(String(init.body)) as { state: { company: string }; questions: Record<string, unknown> };
      sent.push(body.state.company);
      if (calls === 1) await held;
      return Response.json(yesToAll(body));
    }) as typeof fetch;
    const first = runAiFields(owner, { deadline: SOON(), fetchImpl, env: ENV });
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await checkFieldAgain(owner, field.id);
    const second = await runAiFields(owner, { deadline: SOON(), fetchImpl, env: ENV });
    assert.equal(second.checked, 0);
    releaseFirst();
    await first;
    assert.deepEqual(sent.sort(), ["Alpha Agency", "Beta Studio", "Gamma Group"]);
    assert.equal((await spendThisMonth(owner)).decisions >= 3, true);

    await checkFieldAgain(owner, field.id);
    const counted = fakeParallel({ decide: yesToAll });
    await Promise.all([
      runAiFields(owner, { deadline: SOON(), fetchImpl: counted.fetchImpl, env: ENV }),
      runAiFields(owner, { deadline: SOON(), fetchImpl: counted.fetchImpl, env: ENV }),
    ]);
    assert.equal(decisionsSent(counted).length, 3);
    await removeAll();
  });

  it("counts a Task run once when it starts and collects it once when two passes overlap", async () => {
    const staff = await saveAiField(owner, { label: "Staff", question: "How many people work at this agency?", kind: "number", fillsSize: false });
    let status = "running";
    const api = fakeParallel({ status: () => status, task: (input, schema) => ({ content: { [Object.keys(schema.properties)[0]]: input.company === "Alpha Agency" ? "about 1,200" : "~50" } }) });
    const before = (await spendThisMonth(owner)).tasks;
    const started = await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(started.started, 3);
    assert.equal((await spendThisMonth(owner)).tasks, before + 3);
    status = "completed";
    const [a, b] = await Promise.all([
      runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV }),
      runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV }),
    ]);
    assert.equal(a.collected + b.collected, 3);
    assert.equal(api.sent.filter((item) => item.url.includes("/result")).length, 3);
    assert.equal((await spendThisMonth(owner)).tasks, before + 3);
    assert.equal((await getAnswer(owner, staff.id, alpha)).answer.value, 1200);
    assert.equal((await getAnswer(owner, staff.id, beta)).answer.value, 50);
    await removeAll();
  });

  it("reads loose numbers from Task answers", () => {
    assert.equal(looseNumber("about 1,200"), 1200);
    assert.equal(looseNumber("~50"), 50);
    assert.equal(looseNumber("1.2 million"), 1_200_000);
    assert.equal(looseNumber("10-20 people"), 15);
    assert.equal(looseNumber("14 members"), 14);
    assert.equal(looseNumber("none listed"), null);
    assert.equal(looseNumber(""), null);
    assert.equal(looseNumber(64), 64);
  });

  it("stops on out of credit and rate limiting, and records a pass where every company failed", async () => {
    const field = await saveAiField(owner, { label: "Hiring", question: "Is this company hiring right now?", kind: "yes_no" });
    const credit = fakeParallel({ decide: () => new Response("no", { status: 402 }) });
    const out = await runAiFields(owner, { deadline: SOON(), fetchImpl: credit.fetchImpl, env: ENV });
    assert.equal(out.error, "Parallel is out of credit.");
    assert.equal(decisionsSent(credit).length, 1);
    assert.equal((await listAiFields(owner))[0].lastError, "Parallel is out of credit.");

    await getAdminPool().query("update crm.ai_field_answers set next_check_at = now() - interval '1 minute' where field_id = $1", [field.id]);
    const limited = fakeParallel({ decide: () => new Response("slow down", { status: 429 }) });
    const slow = await runAiFields(owner, { deadline: SOON(), fetchImpl: limited.fetchImpl, env: ENV });
    assert.equal(slow.error, "Parallel is busy. Try again in a minute.");
    assert.equal(decisionsSent(limited).length, 2);

    await getAdminPool().query("update crm.ai_field_answers set next_check_at = now() - interval '1 minute' where field_id = $1", [field.id]);
    const broken = fakeParallel({ decide: () => new Response("oops", { status: 500 }) });
    const failed = await runAiFields(owner, { deadline: SOON(), fetchImpl: broken.fetchImpl, env: ENV });
    assert.equal(failed.error, undefined);
    assert.equal(failed.failed, 3);
    assert.equal(decisionsSent(broken).length, 6);
    assert.equal((await listAiFields(owner))[0].lastError, "Couldn't reach Parallel. Try again.");

    await getAdminPool().query("update crm.ai_field_answers set next_check_at = now() - interval '1 minute' where field_id = $1", [field.id]);
    await runAiFields(owner, { deadline: SOON(), fetchImpl: fakeParallel({ decide: yesToAll }).fetchImpl, env: ENV });
    assert.equal((await listAiFields(owner))[0].lastError, null);

    await getAdminPool().query("insert into crm.ai_field_spend (workspace_id, month, decisions, tasks) values ($1, date_trunc('month', now())::date, 100000, 0) on conflict (workspace_id, month) do update set decisions = 100000", [owner.workspaceId]);
    await markCompanyDue(owner, alpha);
    const capped = await runAiFields(owner, { deadline: SOON(), companyId: alpha, fetchImpl: broken.fetchImpl, env: ENV });
    const capMessage = checkNowMessage(capped);
    assert.ok("error" in capMessage && /limit of \$100 reached/.test(capMessage.error));
    await getAdminPool().query("delete from crm.ai_field_spend where workspace_id = $1", [owner.workspaceId]);
    const nothing = await runAiFields(owner, { deadline: SOON(), companyId: alpha, fieldIds: ["3f0e2c1a-0000-4000-8000-000000000000"], fetchImpl: broken.fetchImpl, env: ENV });
    assert.deepEqual(checkNowMessage(nothing), { ok: true, message: "Nothing to check" });
    await removeAll();
  });

  it("asks more than 100 Decisions questions in more than one request and caps the total", async () => {
    const options = Array.from({ length: 30 }, (_, index) => `Option ${index + 1}`);
    const fields = [];
    for (const index of [1, 2, 3, 4]) {
      fields.push(await saveAiField(owner, { label: `Many ${index}`, question: `Which of these services does it offer, list ${index}?`, kind: "pick", options, multiple: true }));
    }
    const batches = decisionBatches(fields);
    assert.deepEqual(batches.map((batch) => Object.keys(batch.questions).length), [90, 30]);
    const api = fakeParallel({ decide: (body) => ({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, noul(key.endsWith("_o0") ? 0.9 : 0.1)])), citations: [] }) });
    await runAiFields(owner, { deadline: SOON(), companyId: alpha, fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(decisionsSent(api).length, 2);
    assert.ok(decisionsSent(api).every((item) => Object.keys((item.body as { questions: object }).questions).length <= 100));
    const { answers } = await getCompanyAnswers(owner, alpha);
    assert.deepEqual(answers.map((answer) => answer.value), fields.map(() => ["Option 1"]));
    for (const index of [5, 6]) {
      await saveAiField(owner, { label: `Many ${index}`, question: `Which of these services does it offer, list ${index}?`, kind: "pick", options, multiple: true });
    }
    await assert.rejects(
      saveAiField(owner, { label: "Many 7", question: "Which of these services does it offer, list 7?", kind: "pick", options, multiple: true }),
      /questions \(210 of 200\)/,
    );
    await removeAll();
  });

  it("runs for companies an agent adds, reading saved views and spend as the agent", async () => {
    const view = await createCompanyView(owner, { name: "Everyone", params: "" });
    const field = await saveAiField(owner, { label: "Hiring", question: "Is this company hiring right now?", kind: "yes_no", scope: "view", scopeViewId: view.id });
    const { actor } = await createAgent(owner.workspaceId, ["crm:read", "companies:write"]);
    const made = (await createCompany(actor, { name: "Delta Digital", domain: "delta.test" })).body.company.id;
    assert.equal((await spendThisMonth(actor)).decisions >= 0, true);
    const api = fakeParallel({ decide: yesToAll });
    const report = await runAiFields(actor, { deadline: SOON(), companyId: made, fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(report.error, undefined);
    assert.equal((await getAnswer(owner, field.id, made)).answer.value, true);
    assert.equal((await listAiFields(owner))[0].lastError, null);
    const [company] = await getCompaniesByIds(actor, [made], { aiFields: true });
    assert.equal(company.aiFields?.[field.id].value, true);
    await getAdminPool().query("update crm.companies set archived_at = now() where id = $1", [made]);
    await removeAll();
    await deleteCompanyView(owner, view.id);
  });

  it("keeps web answers out of only mine workflows and recent changes", async () => {
    const field = await saveAiField(owner, { label: "Hiring", question: "Is this company hiring right now?", kind: "yes_no" });
    await runAiFields(owner, { deadline: SOON(), fetchImpl: fakeParallel({ decide: yesToAll }).fetchImpl, env: ENV });
    const events = await getAdminPool().query<{ actor_user_id: string | null; data: { automatic?: boolean } }>(
      "select actor_user_id, data from crm.workflow_events where event_type = 'company.ai_field_changed' and data->'aiField'->>'id' = $1",
      [field.id],
    );
    assert.equal(events.rows.length, 3);
    assert.ok(events.rows.every((row) => row.actor_user_id === null && row.data.automatic === true));
    await setManualAnswer(owner, field.id, alpha, "no");
    const manual = await getAdminPool().query<{ actor_user_id: string | null }>(
      "select actor_user_id from crm.workflow_events where event_type = 'company.ai_field_changed' and entity_id = $1 and data->'aiField'->>'id' = $2 and not (data ? 'automatic')",
      [alpha, field.id],
    );
    assert.equal(manual.rows[0].actor_user_id, owner.userId);
    assert.ok(!(await listRecentChanges(owner)).some((change) => change.type === "company.ai_field_changed"));
    await removeAll();
  });

  it("checks at most 40 companies a pass", async () => {
    for (let index = 0; index < 42; index += 1) await createCompany(owner, { name: `Bulk ${index}`, domain: `bulk${index}.test` });
    await saveAiField(owner, { label: "Hiring", question: "Is this company hiring right now?", kind: "yes_no" });
    const api = fakeParallel({ decide: yesToAll });
    const report = await runAiFields(owner, { deadline: SOON(), fetchImpl: api.fetchImpl, env: ENV });
    assert.equal(report.checked, COMPANIES_PER_RUN);
    assert.equal(decisionsSent(api).length, COMPANIES_PER_RUN);
    await removeAll();
  });
});
