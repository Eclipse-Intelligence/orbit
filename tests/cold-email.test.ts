import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { bodyCore, checkColdEmail, COLD_EMAIL_PLAYBOOK, figuresIn, lintColdEmail } from "@/lib/assistant/cold-email";
import { systemPrompt } from "@/lib/assistant/prompt";
import { runTool, toolDefinitions } from "@/lib/assistant/tools";
import type { UserActor } from "@/lib/crm/types";

const ARTICLE = "https://geteclipse.co/articles/why-your-ai-visibility-platform-needs-repeated-prompt-tests/";

const STRONG = {
  subject: "Runs behind AI visibility scores",
  body: `Hi David,\n\nYour 2 Oct post asked how teams choose the prompts behind an AI visibility score. The next question is how many runs sit behind each prompt. A brand named in 6 of 20 runs scores 30%, but the plausible range is roughly 15% to 52%. Our article on repeated prompt tests shows how to separate a real lift from normal churn.\n\n${ARTICLE}\n\nHow many runs per prompt do you use before reporting a change to a client?\n\nMark`,
};

const WEAK = {
  subject: "AI visibility prompts",
  body: "Hi David,\n\nYour 2 Oct post asked how teams choose the prompts behind an AI visibility score. Our article reaches the same answer, that prompt choice decides what a score means. Eclipse shows how a brand is mentioned alongside competitors across ten AI assistants. Shall I send you the article?\n\nMark",
};

const TYLER = {
  subject: "Repeats in weekly tracking",
  body: "Hi Tyler,\n\nYour CORE Analysis runs 200+ buyer prompts through five AI models, and your retainers include weekly AI visibility tracking. If the weekly budget is tighter than the analysis, one variance study suggests where to cut. In LLM brand answers, a repeat past the fifth reduced relative-error variance by about 0.0003, while spreading the same budget across languages or models reduced it several times more. So paraphrases and engines may earn more than reruns. I covered it in this guide for agencies.\n\nhttps://geteclipse.co/articles/proving-client-ai-visibility-an-agency-evidence-guide/\n\nHow many repeats per prompt do you run in a client's weekly tracking?\n\nMark",
};

const EVIDENCE = [
  { fact: "David's LinkedIn post asked how teams choose the prompts behind an AI visibility score.", source: "linkedin.com/posts/david 2 Oct 2026" },
  { fact: "Article: a brand named in 6 of 20 runs scores 30%, but the plausible range is roughly 15% to 52%.", source: ARTICLE },
];

const OFFER = "Omniscient reports AI share of voice and citation share to clients on its own dashboard.";

const actor = { type: "user", userId: "u", workspaceId: "w", email: "mark@eclipse.test", fullName: "Mark", role: "owner", scopes: [] } as unknown as UserActor;

function failed(checks: { id: string; pass: boolean }[]) {
  return checks.filter((check) => !check.pass).map((check) => check.id);
}

describe("cold email rule checks", () => {
  it("passes the email that gives something new and flags one that gates the article", () => {
    assert.ok(!bodyCore(STRONG.body).endsWith("Mark"));
    assert.deepEqual(figuresIn(STRONG.body), ["6 of 20", "30%", "15%", "52%"]);
    assert.deepEqual(failed(lintColdEmail({ ...STRONG, evidence: EVIDENCE })), []);
    const weak = lintColdEmail({ ...WEAK, evidence: EVIDENCE });
    assert.deepEqual(failed(weak), ["gives_first"]);
    assert.match(weak.find((check) => check.id === "gives_first")!.note, /Offers to send something general instead of including it/);
  });

  it("flags an email that describes the prospect's own business back to them", () => {
    const check = lintColdEmail({ ...TYLER, evidence: [] }).find((item) => item.id === "not_about_them")!;
    assert.equal(check.pass, false);
    assert.match(check.note, /The sentence about them is long: "Your CORE Analysis runs 200\+ buyer prompts/);
    assert.equal(lintColdEmail({ ...STRONG, evidence: EVIDENCE }).find((item) => item.id === "not_about_them")!.note, "One short reference to them.");
  });

  it("only allows figures that appear in the evidence, and still bans hype, meetings, colons and piece", () => {
    const unsourced = lintColdEmail({ ...STRONG, evidence: EVIDENCE.slice(0, 1) });
    assert.match(unsourced.find((check) => check.id === "numbers_sourced")!.note, /Not in your evidence: 6 of 20, 30%, 15%, 52%/);
    const pushy = lintColdEmail({
      subject: "Re: Quick question!",
      body: "Hi David,\n\nI hope this email finds you well. Our game-changing platform delivers 10x results: I wrote a piece on it. Do you have 15 minutes for a call next week? Or should I send a deck?\n\nMark",
      evidence: EVIDENCE,
    });
    for (const id of ["subject", "one_cta", "gives_first", "numbers_sourced", "no_meeting", "no_filler", "no_colons", "no_piece"]) assert.ok(failed(pushy).includes(id), id);
  });
});

describe("cold email triggers, subjects and tailored offers", () => {
  const base = {
    body: `Hi Sam,\n\nSaw you're hiring a head of content. Teams that scale content quickly often can't tell whether it shows up in AI answers. A brand named in 6 of 20 runs scores 30%, but the plausible range is roughly 15% to 52%.\n\n${ARTICLE}\n\nWant me to send the five prompts where your brand doesn't appear?\n\nMark`,
    evidence: [...EVIDENCE, { fact: "Pulse is hiring a Head of Content.", source: "market note, 20 Oct" }],
  };

  it("accepts a trigger hook, a hedged problem line and an offer of analysis made for them", () => {
    assert.deepEqual(failed(lintColdEmail({ ...base, subject: "scaling content and AI answers" })), []);
    const general = lintColdEmail({ ...base, subject: "scaling content", body: base.body.replace("Want me to send the five prompts where your brand doesn't appear?", "Shall I send you the full article?") });
    assert.deepEqual(failed(general), ["gives_first"]);
  });

  it("flags subjects with numbers, hype, title case or filler", () => {
    const subjectOf = (subject: string) => lintColdEmail({ ...base, subject }).find((check) => check.id === "subject")!;
    assert.equal(subjectOf("runs behind AI visibility scores").pass, true);
    assert.equal(subjectOf("Pulse and Profound compared").pass, true);
    assert.match(subjectOf("Boost Your AI Visibility Today").note, /hype \("Boost"\), Title Case/);
    assert.match(subjectOf("3 ideas for Pulse").note, /a number/);
    assert.match(subjectOf("hi").note, /1 words/);
    assert.ok(failed(lintColdEmail({ ...base, subject: "quick question" })).includes("no_filler"));
  });

  it("tells the assistant to look for triggers and when it may offer tailored analysis", () => {
    assert.match(COLD_EMAIL_PLAYBOOK, /Triggers: something the company did recently/);
    assert.match(COLD_EMAIL_PLAYBOOK, /market notes Orbit collects nightly/);
    assert.match(COLD_EMAIL_PLAYBOOK, /Want me to send the five prompts where you don't appear\?/);
    assert.match(COLD_EMAIL_PLAYBOOK, /we've helped teams like yours/);
    assert.match(systemPrompt(actor, { webSearch: false }), /hooks on a recent trigger/);
  });
});

describe("cold email value grading", () => {
  afterEach(() => {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.LLM_API_KEY;
  });

  it("asks Jev whether it tells them something new, gives value without a reply and avoids pitching what they have", async () => {
    process.env.TYPESAFE_API_KEY = "ts-test";
    const sent: { questions: Record<string, { type: string; criteria: unknown }>; state: { prospect_company_already_offers: string } }[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({
        answers: {
          opener_grounded: { type: "noul", noul: 0.95 },
          not_telling_them_about_themselves: { type: "noul", noul: 0.15 },
          opener_relevant: { type: "noul", noul: 0.9 },
          problem_hedged: { type: "noul", noul: 0.9 },
          claims_supported: { type: "noul", noul: 0.9 },
          subject_honest: { type: "noul", noul: 0.95 },
          coherent: { type: "noul", noul: 0.9 },
          new_information: { type: "noul", noul: 0.2 },
          value_without_reply: { type: "noul", noul: 0.1 },
          not_their_own_product: { type: "noul", noul: 0.3 },
          cta_kind: { type: "choice", choice: "useful_offer" },
          worth_replying: { type: "score", score: 0.8 },
          sounds_human: { type: "score", score: 2.1 },
        },
      });
    };
    const result = await checkColdEmail({ ...WEAK, evidence: EVIDENCE, theirOffer: OFFER }, { fetchImpl });
    assert.equal(sent[0].state.prospect_company_already_offers, OFFER);
    assert.deepEqual(Object.keys((sent[0].questions.cta_kind.criteria as Record<string, string>)).slice(0, 3), ["question_about_their_work", "tailored_offer", "useful_offer"]);
    assert.equal(result.graded, "Rule checks and Jev grading.");
    assert.deepEqual(
      result.checks.filter((check) => !check.pass).map((check) => check.id),
      ["gives_first", "not_telling_them_about_themselves", "new_information", "value_without_reply", "not_their_own_product", "cta_kind", "worth_replying"],
    );
    assert.ok(result.fixes.some((fix) => fix.startsWith("Tells them something new: Take their point one step further")));
  });

  it("uses Orbit's own AI for the value questions when Jev isn't available", async () => {
    process.env.LLM_API_KEY = "llm-test";
    const prompts: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      prompts.push(body.messages.map((message: { content: string }) => message.content).join("\n"));
      return Response.json({
        model: "test",
        choices: [
          {
            message: {
              content: JSON.stringify({
                newInformation: true,
                valueWithoutReply: true,
                pitchesWhatTheyHave: false,
                questionAboutTheirWork: true,
                describesThemToThemselves: false,
                worthReplying: 2.5,
                biggestGap: "",
              }),
            },
            finish_reason: "stop",
          },
        ],
      });
    };
    const result = await checkColdEmail({ ...STRONG, evidence: EVIDENCE, theirOffer: OFFER }, { fetchImpl });
    assert.equal(result.ready, true);
    assert.equal(result.graded, "Rule checks and an AI value review.");
    assert.match(prompts[0], /What their company already offers:\nOmniscient reports AI share of voice/);
    assert.match(prompts[0], /busy expert/);
  });

  it("says plainly when no value grading ran", async () => {
    const result = await checkColdEmail({ ...STRONG, evidence: EVIDENCE });
    assert.match(result.graded, /^Rule checks only\. The value review didn't run/);
  });
});

describe("assistant guidance", () => {
  it("gives the assistant the playbook and the check, and tells it to aim for value", async () => {
    const names = toolDefinitions().map((tool) => tool.function.name);
    assert.ok(names.includes("cold_email_playbook") && names.includes("cold_email_check"));
    const playbook = (await runTool(actor, "cold_email_playbook", {})) as { playbook: string; eclipseBrief: string };
    assert.match(playbook.playbook, /what can this email tell them that they probably don't already know/);
    assert.match(playbook.playbook, /Shall I send you the article/);
    assert.match(playbook.eclipseBrief, /Figures and examples from Eclipse's own published articles may be quoted exactly/);
    const prompt = systemPrompt(actor, { webSearch: false });
    assert.match(prompt, /Always read cold_email_playbook first/);
    assert.match(prompt, /worth a busy expert's time/);
    assert.match(prompt, /never tells them about themselves/);
    assert.match(playbook.playbook, /Telling them about themselves is not value either/);
    assert.match(prompt, /Never put a colon in the middle of a sentence/);
  });
});
