import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { bodyCore, checkColdEmail, COLD_EMAIL_PLAYBOOK, ECLIPSE_OUTREACH_BRIEF, evidenceFrom, figuresIn, lintColdEmail, type Evidence } from "@/lib/assistant/cold-email";
import { systemPrompt } from "@/lib/assistant/prompt";
import { runTool, toolDefinitions } from "@/lib/assistant/tools";
import type { UserActor } from "@/lib/crm/types";

const ARTICLE = "https://geteclipse.co/articles/why-your-ai-visibility-platform-needs-repeated-prompt-tests/";

const FINDING = {
  subject: "runs behind AI visibility scores",
  body: "Hi David,\n\nYour 2 Oct post asked how teams choose the prompts behind an AI visibility score. The harder question may be how many times each prompt runs. A brand named in 6 out of 20 runs could just as easily be named in 3 or 10 next time.\n\nHow many runs per prompt do you use before you report a change to a client?\n\nMark",
};

const WEAK = {
  subject: "AI visibility prompts",
  body: "Hi David,\n\nYour 2 Oct post asked how teams choose the prompts behind an AI visibility score. Our article reaches the same answer, that prompt choice decides what a score means for a client. Eclipse shows how a brand is mentioned alongside competitors across ten AI assistants. Shall I send you the article?\n\nMark",
};

const TYLER = {
  subject: "repeats in weekly tracking",
  body: "Hi Tyler,\n\nYour CORE Analysis runs 200+ buyer prompts through five AI models, and your retainers include weekly AI visibility tracking. If the weekly budget is tighter than the analysis, one variance study suggests where to cut. So paraphrases and engines may earn more than reruns.\n\nHow many repeats per prompt do you run in a client's weekly tracking?\n\nMark",
};

const EVIDENCE: Evidence[] = [
  { fact: "David's LinkedIn post asked how teams choose the prompts behind an AI visibility score.", source: "linkedin.com/posts/david 2 Oct 2026" },
  { fact: "Article: a brand named in 6 out of 20 runs could just as easily be named in 3 or 10 next time.", source: ARTICLE },
];

const PROOF = {
  subject: "client content as you grow",
  body: "Hi Priya,\n\nSaw you've started offering AI search work to your B2B clients this autumn.\n\nNorthwind, a 12-person B2B SEO agency, moved their client content into Eclipse in March. They went from two articles a month per client to eight.\n\nHow are you keeping research and sources consistent as the client list grows?\n\nMark",
};

const NORTHWIND: Evidence = {
  kind: "proof",
  fact: "12-person B2B SEO agency serving B2B SaaS clients, moved client content into Eclipse in March 2026.",
  source: "Knowledge kn_proof_list, entry 1",
  client: "Northwind",
  permission: "named",
  approvedWording: "They went from two articles a month per client to eight.",
};

const PROOF_EVIDENCE: Evidence[] = [{ fact: "Priya's agency announced AI search services for B2B clients.", source: "linkedin.com/posts/priya 14 Oct 2026" }, NORTHWIND];

const OFFER = "Omniscient reports AI share of voice and citation share to clients on its own dashboard.";

const actor = { type: "user", userId: "u", workspaceId: "w", email: "mark@eclipse.test", fullName: "Mark", role: "owner", scopes: [] } as unknown as UserActor;

function failed(checks: { id: string; pass: boolean }[]) {
  return checks.filter((check) => !check.pass).map((check) => check.id);
}

function noteOf(checks: { id: string; note: string }[], id: string) {
  return checks.find((check) => check.id === id)!.note;
}

describe("cold email rule checks", () => {
  it("passes the v2 finding example and flags one that gates the article", () => {
    assert.ok(!bodyCore(FINDING.body).endsWith("Mark"));
    assert.deepEqual(figuresIn(FINDING.body), ["6 out of 20"]);
    assert.deepEqual(failed(lintColdEmail({ ...FINDING, evidence: EVIDENCE })), []);
    const weak = lintColdEmail({ ...WEAK, evidence: EVIDENCE });
    assert.deepEqual(failed(weak), ["gives_first"]);
    assert.match(noteOf(weak, "gives_first"), /Offers to send something general instead of including it/);
  });

  it("fails a link or an attachment in a first email, but not in the follow-up", () => {
    const linked = { ...FINDING, body: FINDING.body.replace("next time.", `next time.\n\n${ARTICLE}`) };
    const checks = lintColdEmail({ ...linked, evidence: EVIDENCE });
    assert.deepEqual(failed(checks), ["no_link"]);
    assert.equal(noteOf(checks, "no_link"), "Has a link.");
    const bare = lintColdEmail({ ...FINDING, body: FINDING.body.replace("next time.", "next time, as geteclipse.co/articles shows."), evidence: EVIDENCE });
    assert.ok(failed(bare).includes("no_link"));
    const attached = lintColdEmail({ ...FINDING, body: FINDING.body.replace("next time.", "next time, as the attached PDF shows."), evidence: EVIDENCE });
    assert.equal(noteOf(attached, "no_link"), "Mentions an attachment.");
    const followUp = "Hi David,\n\nOne more on this. A brand named in 6 out of 20 runs could just as easily be named in 3 or 10 next time, which is why we test each prompt several times.\n\n" + ARTICLE + "\n\nNo need to reply if it's not on your list right now.\n\nMark";
    assert.ok(!failed(lintColdEmail({ subject: "runs behind scores", body: followUp, firstTouch: false, evidence: EVIDENCE })).includes("no_link"));
  });

  it("flags two figures and a 95-word body", () => {
    const twoFigures = lintColdEmail({
      ...FINDING,
      body: FINDING.body.replace("could just as easily be named in 3 or 10 next time.", "scores 30%, though it could just as easily be named in 3 or 10 next time."),
      evidence: [...EVIDENCE, { fact: "Article: a brand named in 6 out of 20 runs scores 30%.", source: ARTICLE }],
    });
    assert.deepEqual(failed(twoFigures), ["one_figure"]);
    assert.equal(noteOf(twoFigures, "one_figure"), "2 figures: 6 out of 20, 30%.");
    const long = FINDING.body.replace(
      "next time.",
      "next time, because answers shift from one run to the next even when nothing about the brand has changed, and that churn is easy to mistake for a real lift in a client report.",
    );
    const checks = lintColdEmail({ ...FINDING, body: long, evidence: EVIDENCE });
    assert.deepEqual(failed(checks), ["length"]);
    assert.match(noteOf(checks, "length"), /^95 words in the body \(aim for 50 to 90, never over 100\)/);
  });

  it("flags an email that describes the prospect's own business back to them", () => {
    const check = lintColdEmail({ ...TYLER, evidence: [] }).find((item) => item.id === "not_about_them")!;
    assert.equal(check.pass, false);
    assert.match(check.note, /The sentence about them is long: "Your CORE Analysis runs 200\+ buyer prompts/);
    assert.equal(noteOf(lintColdEmail({ ...FINDING, evidence: EVIDENCE }), "not_about_them"), "One short reference to them.");
  });

  it("only allows figures that appear in the evidence, and still bans hype, meetings, colons and piece", () => {
    const unsourced = lintColdEmail({ ...FINDING, evidence: EVIDENCE.slice(0, 1) });
    assert.match(noteOf(unsourced, "numbers_sourced"), /Not in your evidence: 6 out of 20/);
    const pushy = lintColdEmail({
      subject: "Re: Quick question!",
      body: "Hi David,\n\nI hope this email finds you well. Our game-changing platform delivers 10x results: I wrote a piece on it. Do you have 15 minutes for a call next week? Or should I send a deck?\n\nMark",
      evidence: EVIDENCE,
    });
    for (const id of ["subject", "one_cta", "gives_first", "numbers_sourced", "no_multipliers", "no_meeting", "no_filler", "no_colons", "no_piece"]) assert.ok(failed(pushy).includes(id), id);
  });

  it("keeps the booking link, video, pricing, the pilot and promises out of a first email", () => {
    const extras = lintColdEmail({
      ...FINDING,
      body: FINDING.body.replace(
        "next time.",
        "next time. The Agency Pilot is £595 for a month, and I can record a Loom. Book at https://orbit.geteclipse.co/book/mark and we can do the same for you.",
      ),
      evidence: EVIDENCE,
    });
    for (const id of ["no_link", "no_meeting", "no_first_email_extras", "no_promise"]) assert.ok(failed(extras).includes(id), id);
    assert.match(noteOf(extras, "no_first_email_extras"), /a video or Loom, pricing and the pilot/);
    const bullets = lintColdEmail({ ...FINDING, body: FINDING.body.replace("The harder question", "\n- **The harder question**"), evidence: EVIDENCE });
    assert.equal(noteOf(bullets, "plain_text"), "Uses bullets and bold.");
  });
});

describe("cold email client proof", () => {
  it("passes approved proof quoted word for word within its permission", () => {
    const checks = lintColdEmail({ ...PROOF, evidence: PROOF_EVIDENCE });
    assert.deepEqual(failed(checks), []);
    assert.equal(noteOf(checks, "proof_approved"), "Quotes the proof entry for Northwind (named) word for word.");
    const described = { ...NORTHWIND, permission: "described" as const };
    const anonymous = PROOF.body.replace("Northwind, a 12-person B2B SEO agency, moved", "A 12-person B2B SEO agency moved");
    assert.deepEqual(failed(lintColdEmail({ ...PROOF, body: anonymous, evidence: [PROOF_EVIDENCE[0], described] })), []);
  });

  it("fails proof with no proof entry behind it", () => {
    const checks = lintColdEmail({ ...PROOF, evidence: PROOF_EVIDENCE.slice(0, 1) });
    assert.deepEqual(failed(checks), ["proof_approved"]);
    assert.match(noteOf(checks, "proof_approved"), /^States a client result or names a client with no proof entry behind it/);
    const pitch = lintColdEmail({ subject: "content results", body: "Hi Sam,\n\nWe helped a SaaS client publish more. We can do the same for Pulse. Have you got 15 minutes this week?\n\nMark", evidence: [] });
    for (const id of ["proof_approved", "no_promise", "no_meeting"]) assert.ok(failed(pitch).includes(id), id);
  });

  it("fails proof whose wording doesn't match the approved wording", () => {
    const reworded = PROOF.body.replace("They went from two articles a month per client to eight.", "They now publish eight articles a month for every client.");
    const checks = lintColdEmail({ ...PROOF, body: reworded, evidence: PROOF_EVIDENCE });
    assert.deepEqual(failed(checks), ["proof_approved"]);
    assert.equal(noteOf(checks, "proof_approved"), "The result for Northwind doesn't match its approved wording word for word.");
    const anonymous = reworded.replace("Northwind, a 12-person B2B SEO agency, moved", "A 12-person B2B SEO agency moved");
    assert.match(noteOf(lintColdEmail({ ...PROOF, body: anonymous, evidence: PROOF_EVIDENCE }), "proof_approved"), /doesn't match the approved wording of any proof entry/);
  });

  it("fails a described only entry that names the client", () => {
    const checks = lintColdEmail({ ...PROOF, evidence: [PROOF_EVIDENCE[0], { ...NORTHWIND, permission: "described" }] });
    assert.deepEqual(failed(checks), ["proof_approved"]);
    assert.equal(noteOf(checks, "proof_approved"), "Names Northwind, whose entry is described only.");
  });

  it("fails an incomplete proof entry, a finding next to proof, and a client name in the subject", () => {
    const incomplete = lintColdEmail({ ...PROOF, evidence: [PROOF_EVIDENCE[0], { ...NORTHWIND, permission: undefined, source: undefined }] });
    assert.equal(noteOf(incomplete, "proof_approved"), "The proof entry for Northwind is missing its Knowledge link and the permission.");
    const mixed = lintColdEmail({
      ...PROOF,
      body: PROOF.body.replace("to eight.", "to eight. Our article shows a brand named in 6 out of 20 runs could be named in 3 next time."),
      evidence: [...PROOF_EVIDENCE, ...EVIDENCE],
    });
    assert.ok(failed(mixed).includes("one_angle"));
    assert.match(noteOf(lintColdEmail({ ...PROOF, subject: "what Northwind changed", evidence: PROOF_EVIDENCE }), "subject"), /a client's name/);
  });

  it("reads proof entries from the tool's evidence input", async () => {
    assert.deepEqual(
      evidenceFrom([
        { kind: "proof", source: " kn_1 ", client: "Northwind", permission: "described only", approvedWording: "They went from two articles a month per client to eight." },
        { fact: "A post.", source: "linkedin", permission: "named" },
        { source: "no fact" },
        "junk",
      ]),
      [
        { fact: "They went from two articles a month per client to eight.", kind: "proof", source: "kn_1", client: "Northwind", permission: "described", approvedWording: "They went from two articles a month per client to eight." },
        { fact: "A post.", source: "linkedin" },
      ],
    );
    const result = (await runTool(actor, "cold_email_check", {
      ...PROOF,
      evidence: [PROOF_EVIDENCE[0], { ...NORTHWIND, permission: "described_only" }],
    })) as { checks: { id: string; pass: boolean; note: string }[]; fixes: string[] };
    assert.equal(noteOf(result.checks, "proof_approved"), "Names Northwind, whose entry is described only.");
    assert.ok(result.fixes.some((fix) => fix.startsWith("Client proof is approved: Replace the name with a short description")));
  });
});

describe("cold email triggers, subjects and tailored offers", () => {
  const MADE_FOR_THEM = {
    subject: "buyer questions in ChatGPT",
    body: "Hi Sam,\n\nSaw you're hiring a head of content.\n\nNew content teams often can't tell whether anything they publish shows up when buyers ask ChatGPT or Perplexity.\n\nWant me to send the five buyer questions where Pulse doesn't come up today?\n\nMark",
    evidence: [{ fact: "Pulse is hiring a Head of Content.", source: "market note, 20 Oct" }],
  };

  it("accepts the made for them example and flags a general offer instead", () => {
    assert.deepEqual(failed(lintColdEmail(MADE_FOR_THEM)), []);
    const general = lintColdEmail({ ...MADE_FOR_THEM, body: MADE_FOR_THEM.body.replace("Want me to send the five buyer questions where Pulse doesn't come up today?", "Shall I send you the full article?") });
    assert.ok(failed(general).includes("gives_first"));
  });

  it("flags subjects with numbers, hype, title case, urgency, first names or filler", () => {
    const subjectOf = (subject: string) => lintColdEmail({ ...FINDING, subject, evidence: EVIDENCE }).find((check) => check.id === "subject")!;
    assert.equal(subjectOf("runs behind AI visibility scores").pass, true);
    assert.equal(subjectOf("Pulse and Profound compared").pass, true);
    assert.match(subjectOf("Boost Your AI Visibility Today").note, /hype \("Boost"\), Title Case, urgency \("Today"\)/);
    assert.match(subjectOf("3 ideas for Pulse").note, /a number/);
    assert.match(subjectOf("hi").note, /1 words/);
    assert.match(subjectOf("how many runs sit behind scores").note, /6 words/);
    assert.match(subjectOf("Re: runs per prompt").note, /a fake reply prefix/);
    assert.match(subjectOf("David, runs per prompt").note, /their first name/);
    assert.match(subjectOf("runs per prompt \u{1F680}").note, /an emoji/);
    assert.match(subjectOf("quick question").note, /"quick question"/);
    assert.ok(failed(lintColdEmail({ ...FINDING, subject: "quick question", evidence: EVIDENCE })).includes("no_filler"));
  });

  it("gives the follow-up its own length and lets it end with an easy way out", () => {
    const followUp = {
      subject: "runs behind AI visibility scores",
      body: "Hi David,\n\nOne more on this. A 12-person B2B SEO agency moved their client content into Eclipse in March. They went from two articles a month per client to eight.\n\nNo need to reply if it's not on your list right now.\n\nMark",
      evidence: [{ ...NORTHWIND, permission: "described" as const }],
    };
    assert.deepEqual(failed(lintColdEmail({ ...followUp, firstTouch: false })), []);
    assert.ok(failed(lintColdEmail(followUp)).includes("one_cta"));
  });

  it("tells the assistant about the three angles, proof and triggers", () => {
    assert.match(COLD_EMAIL_PLAYBOOK, /Triggers\. Look for a hire, funding, a launch/);
    assert.match(COLD_EMAIL_PLAYBOOK, /Check recall and the nightly market notes first/);
    assert.match(COLD_EMAIL_PLAYBOOK, /Want me to send the five questions where you don't come up\?/);
    assert.match(COLD_EMAIL_PLAYBOOK, /Quote only from the list\. Copy figures word for word/);
    assert.match(COLD_EMAIL_PLAYBOOK, /50 to 90 words in 3 to 5 short sentences/);
    assert.match(COLD_EMAIL_PLAYBOOK, /No link and no attachment in a first email/);
    assert.match(COLD_EMAIL_PLAYBOOK, /https:\/\/orbit\.geteclipse\.co\/book\/mark/);
    assert.doesNotMatch(COLD_EMAIL_PLAYBOOK, /None are approved yet/);
    assert.doesNotMatch(COLD_EMAIL_PLAYBOOK, /Until the check is updated/);
    assert.doesNotMatch(ECLIPSE_OUTREACH_BRIEF, /no customer results are approved/);
    assert.doesNotMatch(`${COLD_EMAIL_PLAYBOOK}\n${ECLIPSE_OUTREACH_BRIEF}`, /[–—]/);
    assert.match(systemPrompt(actor, { webSearch: false }), /hooks on a recent trigger/);
  });

  it("names only tools the assistant has", () => {
    const names = new Set(toolDefinitions().map((tool) => tool.function.name));
    const mentioned = [...COLD_EMAIL_PLAYBOOK.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((match) => match[0]);
    assert.ok(mentioned.length >= 10);
    for (const name of mentioned) assert.ok(names.has(name), name);
  });
});

describe("cold email value grading", () => {
  afterEach(() => {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.LLM_API_KEY;
  });

  it("asks Jev whether it tells them something new, gives value without a reply and avoids pitching what they have", async () => {
    process.env.TYPESAFE_API_KEY = "ts-test";
    const sent: { questions: Record<string, { type: string; instructions: string; criteria: unknown }>; state: { prospect_company_already_offers: string; approved_product_claims: string } }[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({
        answers: {
          opener_grounded: { type: "noul", noul: 0.95 },
          not_telling_them_about_themselves: { type: "noul", noul: 0.15 },
          opener_relevant: { type: "noul", noul: 0.9 },
          problem_hedged: { type: "noul", noul: 0.9 },
          claims_supported: { type: "noul", noul: 0.9 },
          one_angle: { type: "noul", noul: 0.9 },
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
    assert.match(sent[0].state.approved_product_claims, /Approved client proof may be quoted from the proof list in Knowledge/);
    assert.match(sent[0].questions.claims_supported.instructions, /quoted word for word from the approved_wording of an approved client proof item/);
    assert.match(sent[0].questions.one_angle.instructions, /A finding and client proof in the same email, stacked results or two or more figures count as no/);
    assert.deepEqual(Object.keys(sent[0].questions.cta_kind.criteria as Record<string, string>).slice(0, 3), ["question_about_their_work", "tailored_offer", "useful_offer"]);
    assert.equal(result.graded, "Rule checks and Jev grading.");
    assert.deepEqual(failed(result.checks), ["gives_first", "not_telling_them_about_themselves", "new_information", "value_without_reply", "not_their_own_product", "cta_kind", "worth_replying"]);
    assert.ok(result.fixes.some((fix) => fix.startsWith("Tells them something new: Give them one specific thing")));
  });

  it("sends proof entries to Jev with their permission and approved wording", async () => {
    process.env.TYPESAFE_API_KEY = "ts-test";
    const sent: { state: { prospect_evidence: Record<string, string>[] } }[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ answers: { claims_supported: { type: "noul", noul: 0.2 } } });
    };
    const result = await checkColdEmail({ ...PROOF, evidence: [PROOF_EVIDENCE[0], { ...NORTHWIND, permission: "described" }] }, { fetchImpl });
    assert.deepEqual(sent[0].state.prospect_evidence[1], {
      id: "E2",
      kind: "approved client proof",
      client: "Northwind",
      permission: "described only, never named or identified",
      approved_wording: "They went from two articles a month per client to eight.",
      fact: NORTHWIND.fact,
      source: NORTHWIND.source,
    });
    assert.equal(sent[0].state.prospect_evidence[0].kind, "fact");
    assert.ok(failed(result.checks).includes("claims_supported"));
  });

  it("uses Orbit's own AI for the value questions when Jev isn't available", async () => {
    process.env.LLM_API_KEY = "llm-test";
    const prompts: string[] = [];
    const answer = (claimsWithinEvidence: boolean) =>
      Response.json({
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
                claimsWithinEvidence,
                oneAngle: true,
                worthReplying: 2.5,
                biggestGap: "",
              }),
            },
            finish_reason: "stop",
          },
        ],
      });
    let claimsOk = true;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      prompts.push(body.messages.map((message: { content: string }) => message.content).join("\n"));
      return answer(claimsOk);
    };
    const result = await checkColdEmail({ ...FINDING, evidence: EVIDENCE, theirOffer: OFFER }, { fetchImpl });
    assert.equal(result.ready, true);
    assert.equal(result.graded, "Rule checks and an AI value review.");
    assert.match(prompts[0], /What their company already offers:\nOmniscient reports AI share of voice/);
    assert.match(prompts[0], /busy expert/);
    assert.match(prompts[0], /Approved proof quoted exactly is allowed/);
    assert.match(prompts[0], /Touch: a first email, with no link/);
    claimsOk = false;
    const proof = await checkColdEmail({ ...PROOF, evidence: PROOF_EVIDENCE }, { fetchImpl });
    assert.match(prompts[1], /E2\. Approved client proof for Northwind, may be named\. Approved wording "They went from two articles a month per client to eight\."/);
    assert.deepEqual(failed(proof.checks), ["claims_supported"]);
  });

  it("says plainly when no value grading ran", async () => {
    const result = await checkColdEmail({ ...FINDING, evidence: EVIDENCE });
    assert.match(result.graded, /^Rule checks only\. The value review didn't run/);
  });
});

describe("assistant guidance", () => {
  it("gives the assistant the playbook and the check, and tells it to aim for value", async () => {
    const names = toolDefinitions().map((tool) => tool.function.name);
    assert.ok(names.includes("cold_email_playbook") && names.includes("cold_email_check"));
    const playbook = (await runTool(actor, "cold_email_playbook", {})) as { playbook: string; eclipseBrief: string };
    assert.match(playbook.playbook, /Every email carries one thing they probably don't know\. There are three kinds/);
    assert.match(playbook.playbook, /Never write "we can do the same for you"/);
    assert.match(playbook.eclipseBrief, /Approved client proof may be quoted from the proof list in Knowledge, exactly as approved and within its permission level/);
    assert.match(playbook.eclipseBrief, /Figures from Eclipse's published articles may be quoted exactly/);
    const check = toolDefinitions().find((tool) => tool.function.name === "cold_email_check")!.function as unknown as {
      parameters: { properties: { evidence: { items: { properties: Record<string, { enum?: string[] }> } } } };
    };
    const evidence = check.parameters.properties.evidence.items.properties;
    assert.deepEqual(Object.keys(evidence), ["fact", "source", "kind", "client", "permission", "approvedWording"]);
    assert.deepEqual(evidence.permission.enum, ["named", "described", "reference"]);
    const prompt = systemPrompt(actor, { webSearch: false });
    assert.match(prompt, /Always read cold_email_playbook first/);
    assert.match(prompt, /worth a busy expert's time/);
    assert.match(prompt, /never tells them about themselves/);
    assert.match(prompt, /50 to 90 words with no link or attachment and at most one figure/);
    assert.match(prompt, /approved client proof quoted word for word from the proof list in Knowledge/);
    assert.match(playbook.playbook, /Agreeing with them, repeating their point, describing their own business/);
    assert.match(prompt, /Never put a colon in the middle of a sentence/);
  });
});
