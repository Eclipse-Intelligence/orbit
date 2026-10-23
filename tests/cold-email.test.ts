import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { bodyCore, checkColdEmail, lintColdEmail } from "@/lib/assistant/cold-email";
import { systemPrompt } from "@/lib/assistant/prompt";
import { runTool, toolDefinitions } from "@/lib/assistant/tools";
import type { UserActor } from "@/lib/crm/types";

const GOOD = {
  subject: "Pulse in AI answers",
  body: "Hi Andrew,\n\nI saw Pulse launched its agency reporting product last week. If agencies are asking how clients appear in ChatGPT, that may become part of the report. Eclipse runs weekly prompts across ten AI assistants and shows where your clients are mentioned against competitors. Would a short snapshot for two of your clients be useful?\n\nMark",
};

const BAD = {
  subject: "Re: Quick question!",
  body: "Hi Andrew,\n\nI hope this email finds you well. We are a game-changing platform that will unlock 10x ROI for your agency — our customers love us. We leverage AI to supercharge content. Do you have 15 minutes for a call next week? Or should I send a deck?\n\nMark",
};

const actor = { type: "user", userId: "u", workspaceId: "w", email: "mark@eclipse.test", fullName: "Mark", role: "owner", scopes: [] } as unknown as UserActor;

describe("cold email checks", () => {
  afterEach(() => {
    delete process.env.TYPESAFE_API_KEY;
  });

  it("passes a short, specific email and flags a generic one", () => {
    assert.match(bodyCore(GOOD.body), /^I saw Pulse/);
    assert.ok(!bodyCore(GOOD.body).endsWith("Mark"));
    const good = lintColdEmail(GOOD);
    assert.deepEqual(good.filter((check) => !check.pass).map((check) => check.id), []);
    const bad = lintColdEmail(BAD);
    const failed = bad.filter((check) => !check.pass).map((check) => check.id);
    for (const id of ["subject", "one_cta", "no_meeting", "no_filler", "no_roi", "no_dashes", "about_them"]) assert.ok(failed.includes(id), id);
    const found = bad.find((check) => check.id === "no_filler")!.note;
    for (const phrase of ["i hope this email finds you well", "quick question", "game-changing", "unlock", "leverage", "supercharge"]) assert.ok(found.includes(phrase), phrase);
    assert.equal(lintColdEmail({ ...BAD, firstTouch: false }).find((check) => check.id === "no_meeting")!.pass, true);
    const styled = lintColdEmail({
      subject: "Pulse: AI answers",
      body: "Hi Andrew,\n\nOne thing stood out: your launch last week. I wrote a piece on it at 14:30 yesterday, see https://geteclipse.co/articles/x. Eclipse tracks where your clients appear in AI answers. Would the article be useful?\n\nMark",
    });
    const colons = styled.find((check) => check.id === "no_colons")!;
    assert.equal(colons.pass, false);
    assert.match(colons.note, /Pulse: AI answers/);
    assert.equal(styled.find((check) => check.id === "no_piece")!.pass, false);
    const clean = lintColdEmail({ subject: "Pulse in AI answers", body: "Hi Andrew,\n\nI read your launch post at 14:30 on https://pulse.test/news. Eclipse tracks where your clients appear in AI answers. It shows mentions next to competitors each week. Would the article be useful?\n\nMark" });
    assert.equal(clean.find((check) => check.id === "no_colons")!.pass, true);
    assert.equal(clean.find((check) => check.id === "no_piece")!.pass, true);
  });

  it("adds Jev's grading when it's set up, and keeps going if Jev fails", async () => {
    const sent: { url: string; auth: string | null; body: { model: string; state: { prospect_evidence: { id: string }[]; draft: { cta: string } }; questions: Record<string, { type: string }> } }[] = [];
    process.env.TYPESAFE_API_KEY = "ts-test";
    const fetchImpl: typeof fetch = async (input, init) => {
      sent.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return Response.json({
        model: "jev-1.13",
        answers: {
          opener_grounded: { type: "noul", noul: 0.94 },
          opener_relevant: { type: "noul", noul: 0.88 },
          problem_hedged: { type: "noul", noul: 0.61 },
          claims_supported: { type: "noul", noul: 0.9 },
          subject_honest: { type: "noul", noul: 0.97 },
          coherent: { type: "noul", noul: 0.86 },
          cta_kind: { type: "choice", choice: "useful_offer", confidence: 0.8, probabilities: {} },
          sounds_human: { type: "score", score: 2.3, confidence: 0.6, probabilities: {} },
        },
      });
    };
    const result = await checkColdEmail({ ...GOOD, evidence: [{ fact: "Pulse launched agency reporting", source: "https://pulse.test/news 2026-10-16" }] }, { fetchImpl });
    assert.equal(sent[0].url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(sent[0].auth, "Bearer ts-test");
    assert.equal(sent[0].body.model, "jev-latest");
    assert.equal(sent[0].body.state.prospect_evidence[0].id, "E1");
    assert.equal(sent[0].body.state.draft.cta, "Would a short snapshot for two of your clients be useful?");
    assert.equal(sent[0].body.questions.cta_kind.type, "choice");
    assert.equal(result.ready, false);
    assert.deepEqual(result.fixes, ["Problem framed honestly: Say the problem may apply ('if', 'may'), rather than telling them they have it."]);
    assert.match(result.checks.find((check) => check.id === "problem_hedged")!.note, /61% likely yes, unsure/);
    assert.equal(result.graded, "Rule checks and Jev grading.");

    const down: typeof fetch = async () => new Response("no", { status: 503 });
    const fallback = await checkColdEmail({ ...GOOD, evidence: [] }, { fetchImpl: down });
    assert.equal(fallback.ready, true);
    assert.match(fallback.graded, /Jev grading failed \(Jev answered 503\.\); only the rule checks ran\./);
  });

  it("gives the assistant the playbook and the check, and tells it when to use them", async () => {
    const names = toolDefinitions().map((tool) => tool.function.name);
    assert.ok(names.includes("cold_email_playbook") && names.includes("cold_email_check"));
    const playbook = (await runTool(actor, "cold_email_playbook", {})) as { playbook: string; eclipseBrief: string };
    assert.match(playbook.playbook, /NO-SEND/);
    assert.match(playbook.eclipseBrief, /no customer results are approved/);
    assert.match(systemPrompt(actor, { webSearch: false }), /Always read cold_email_playbook first/);
    assert.match(systemPrompt(actor, { webSearch: false }), /Never put a colon in the middle of a sentence/);
    assert.match(systemPrompt(actor, { webSearch: false }), /Never call an article a "piece"/);
    const checked = (await runTool(actor, "cold_email_check", { ...BAD })) as { ready: boolean; graded: string };
    assert.equal(checked.ready, false);
    assert.match(checked.graded, /Rule checks only/);
  });
});
