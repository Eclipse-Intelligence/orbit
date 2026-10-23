export const COLD_EMAIL_PLAYBOOK = `# Writing a first email to a prospect

Goal: earn a useful human reply from someone who doesn't know the user yet. Not a meeting, not an open.

## 1. Research before writing (use the tools, keep sources)
- Orbit first: get_contact or get_company, recent activity, deals and any emails with them (search_email). Never cold-email someone the user is already talking to; write a normal reply instead.
- Their company: read_web_page on their website (home, about, product, news or blog). Note what they sell, to whom, and anything recent.
- The person: social_lookup linkedin_profile for their current role (it must match before you write), and linkedin_posts or x_posts for anything recent they said about their work.
- News: with web search on, look for recent company news (funding, launches, hiring, new markets).
- Eclipse collateral: eclipse_articles with a query about their situation. A relevant article is often the best useful item to offer.
- Keep a short evidence list: each fact with its source link and date. Only business facts.

## 2. Decide whether to send at all
Pick ONE verified, business-relevant signal and say to yourself why it connects to what Eclipse does. If there is no real fit, or you can't verify their role, don't draft. Tell the user it's a NO-SEND and what is missing (for example "no sign they publish content or care about AI search; need a reason").

## 3. Write it
- Subject: 1 to 4 words, accurate, about their business. No tricks, no "Re:", no fake urgency, no emoji.
- Body: 50 to 80 words in 3 to 5 short sentences (excluding greeting and signature). Greeting is "Hi [first name],".
- Shape: the signal (what you noticed, plainly, with the fact not a compliment), why it may matter for their role (framed as a possibility, not an assumed pain), what Eclipse does about it in concrete terms, then one easy question.
- One call to action, as a question that's easy to answer yes or no, offering something real: the relevant article, a short example, or a snapshot of how they show up in AI answers. Don't ask for a call or meeting in a first email unless they've engaged before.
- Speak to them ("you", "your team"), not about Eclipse's greatness.
- Match their broad register (formal or conversational, technical or plain). Never copy their phrases, jokes or style.
- Sign off with the user's first name only. Orbit adds the signature.

## 4. Never
- Invent or embellish facts, pains, timing, intent, customers or results. State observations as observations; anything inferred is "may", "if".
- Use ROI or multiplier claims ("10x", "double your traffic") or results Eclipse can't show.
- Use filler: "I hope this finds you well", "just checking in", "quick question", "I came across your profile", "I'd love to", "touch base", "circle back".
- Use hype words: delve, unlock, leverage, game-changing, revolutionise, cutting-edge, seamless, synergy, supercharge, elevate, empower.
- Mention personal details from their social life, or anything that would feel like surveillance.
- Use em dashes or en dashes. Use commas, full stops or colons.

## 5. Check, revise, then propose
Run cold_email_check with the subject, body and your evidence list. Fix every failed check (at most two rounds), then propose send_email. In your message to the user, list the signal you used with its source, and anything you weren't sure of.

## Template (replace every bracket with something verified, or cut the line)
Subject: [their business topic]

Hi [first name],

I noticed [one verified fact, with where it came from if natural]. [Why it may matter for someone in their role, as a possibility]. Eclipse [concrete thing it does that connects]. [Optional: one line of proof only if approved]. Would [specific useful item] be useful?

[User's first name]`;

export const ECLIPSE_OUTREACH_BRIEF = `# Eclipse outreach brief (what you may say)

Who it's for: B2B brands, in-house marketing teams, SaaS companies and agencies that publish content to win buyers, especially those starting to care how they appear in AI answers (ChatGPT, Gemini, Perplexity, Claude).

Problem it solves: content that is generic, unsupported or invisible in AI answers; marketing teams that can't prove where they show up in AI search; agencies juggling many clients' content, research and reporting by hand.

What it does (safe to say):
- Plans, writes and reviews articles from the company's own brand context, products, audiences and competitors, with citations and an E-E-A-T review before approval.
- Tracks AI visibility: weekly prompt runs across ten AI assistants, showing whether and how a brand is mentioned, alongside competitors.
- Turns research (news, competitors, Reddit, monitors) into planned content, and distributes it to social and the CMS.
- Gives agencies one place to run every client's content in separate workspaces.

Useful things you can offer:
- A relevant Eclipse article (from eclipse_articles), with its exact link.
- A short snapshot of how their brand shows up in AI answers for a few of their key questions. Only offer this if the user can run it; mention that it would be prepared by hand.
- The live demo workspace (docs.geteclipse.co/getting-started/live-demo).

Proof: no customer results are approved for outreach yet. Don't cite numbers, customer names or outcomes unless the user gives them to you.

Don't claim: guaranteed rankings or AI mentions, traffic or revenue multipliers, that Eclipse "replaces" a team, features listed as not built yet in the Eclipse context, or anything about the prospect's results.`;

export type ColdEmailCheck = { id: string; label: string; pass: boolean; note: string; fix?: string; source: "rules" | "jev" };

const FILLER = [
  "i hope this finds you well",
  "i hope this email finds you well",
  "hope you're well",
  "just checking in",
  "quick question",
  "i came across your profile",
  "touch base",
  "circle back",
  "i'd love to",
  "reaching out to introduce",
];
const HYPE = ["delve", "unlock", "leverage", "game-changing", "game changer", "revolutionise", "revolutionize", "cutting-edge", "seamless", "synergy", "supercharge", "elevate", "empower", "world-class", "best-in-class"];
const MEETING = /\b(call|meeting|chat|demo|calendar|calendly|zoom|teams)\b.*\?|\b(\d+|fifteen|thirty|twenty)[ -]?(min|minute)|\bbook (a|some) time\b|\bjump on\b|\bhop on\b/i;

function words(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function bodyCore(body: string) {
  const lines = body.replace(/\r\n/g, "\n").trim().split("\n");
  const start = /^(hi|hello|hey|dear)\b/i.test(lines[0] ?? "") ? 1 : 0;
  let end = lines.length;
  while (end > start && (lines[end - 1].trim() === "" || (lines[end - 1].trim().split(/\s+/).length <= 3 && !/[?.!]$/.test(lines[end - 1].trim())))) end -= 1;
  return lines.slice(start, end).join("\n").trim();
}

export function sentencesOf(text: string) {
  return text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z"'(])/).map((sentence) => sentence.trim()).filter(Boolean);
}

export function lintColdEmail(input: { subject: string; body: string; firstTouch?: boolean }): ColdEmailCheck[] {
  const subject = input.subject.trim();
  const core = bodyCore(input.body);
  const lower = `${subject}\n${input.body}`.toLowerCase();
  const count = words(core);
  const sentences = sentencesOf(core);
  const questions = sentences.filter((sentence) => sentence.endsWith("?"));
  const subjectWords = words(subject);
  const filler = FILLER.filter((phrase) => lower.includes(phrase));
  const hype = HYPE.filter((word) => new RegExp(`\\b${word}`, "i").test(lower));
  const checks: Omit<ColdEmailCheck, "source">[] = [
    {
      id: "length",
      label: "Length",
      pass: count >= 35 && count <= 100,
      note: `${count} words in the body (aim for 50 to 80).`,
      fix: count < 35 ? "Add what Eclipse does and why it connects; it's too thin to earn a reply." : "Cut it to 50 to 80 words: keep the signal, the link to their role, what Eclipse does and one question.",
    },
    {
      id: "sentences",
      label: "Sentences",
      pass: sentences.length >= 3 && sentences.length <= 6,
      note: `${sentences.length} sentences (aim for 3 to 5).`,
      fix: "Use 3 to 5 short sentences.",
    },
    {
      id: "subject",
      label: "Subject",
      pass: subjectWords >= 1 && subjectWords <= 6 && !/^(re|fw|fwd):/i.test(subject) && !/[!]/.test(subject),
      note: subject ? `"${subject}" (${subjectWords} words).` : "No subject.",
      fix: "Use a 1 to 4 word subject about their business, with no Re:, no exclamation marks and no tricks.",
    },
    {
      id: "one_cta",
      label: "One question",
      pass: questions.length === 1 && Boolean(sentences.at(-1)?.endsWith("?")),
      note: questions.length === 0 ? "No question to answer." : questions.length > 1 ? `${questions.length} questions.` : sentences.at(-1)?.endsWith("?") ? "One closing question." : "The question isn't at the end.",
      fix: "End with exactly one easy yes or no question that offers something useful.",
    },
    {
      id: "no_meeting",
      label: "No meeting ask",
      pass: input.firstTouch === false || !MEETING.test(core),
      note: MEETING.test(core) ? "Asks for a call or meeting." : "Doesn't ask for a meeting.",
      fix: "In a first email, offer something useful (an article, an example, a snapshot) instead of asking for a call.",
    },
    {
      id: "no_filler",
      label: "No filler or hype",
      pass: filler.length === 0 && hype.length === 0,
      note: filler.length || hype.length ? `Found: ${[...filler, ...hype].join(", ")}.` : "None found.",
      fix: "Remove the filler and hype words and say the concrete thing instead.",
    },
    {
      id: "no_roi",
      label: "No unsupported numbers",
      pass: !/\b\d+(\.\d+)?x\b|\broi\b|\b\d+%/i.test(core),
      note: /\b\d+(\.\d+)?x\b|\broi\b|\b\d+%/i.test(core) ? "Contains a multiplier, percentage or ROI claim." : "No claims of that kind.",
      fix: "Remove numbers and results unless the user approved them as proof.",
    },
    {
      id: "no_dashes",
      label: "No dashes",
      pass: !/[–—]| - /.test(`${subject}\n${core}`),
      note: /[–—]| - /.test(`${subject}\n${core}`) ? "Uses a dash." : "No dashes.",
      fix: "Replace dashes with a comma, full stop or colon.",
    },
    {
      id: "about_them",
      label: "About them",
      pass: (core.match(/\b(you|your)\b/gi)?.length ?? 0) >= (core.match(/\b(we|our|us|i|my)\b/gi)?.length ?? 0) - 1,
      note: `"you/your" ${core.match(/\b(you|your)\b/gi)?.length ?? 0} times, "we/our/I" ${core.match(/\b(we|our|us|i|my)\b/gi)?.length ?? 0} times.`,
      fix: "Make it about them: talk about their team and situation more than about Eclipse or yourself.",
    },
  ];
  return checks.map((check) => ({ ...check, source: "rules" as const, ...(check.pass ? { fix: undefined } : {}) }));
}

type Evidence = { fact: string; source?: string };
type JevAnswer = { type: string; noul?: number; choice?: string; score?: number; confidence?: number };

const JEV_URL = "https://api.typesafe.ai/v1/systemone";

export function jevConfigured() {
  return Boolean(process.env.TYPESAFE_API_KEY?.trim());
}

export async function judgeColdEmail(
  input: { subject: string; body: string; evidence: Evidence[]; firstTouch?: boolean },
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ColdEmailCheck[]> {
  if (!jevConfigured()) return [];
  const core = bodyCore(input.body);
  const sentences = sentencesOf(core);
  const question = [...sentences].reverse().find((sentence) => sentence.endsWith("?")) ?? "";
  const state = {
    campaign: { touch: input.firstTouch === false ? "follow-up" : "first email to someone who doesn't know the sender", goal: "earn a useful reply" },
    prospect_evidence: input.evidence.slice(0, 8).map((item, index) => ({ id: `E${index + 1}`, fact: item.fact.slice(0, 400), source: (item.source ?? "").slice(0, 200) })),
    approved_product_claims: ECLIPSE_OUTREACH_BRIEF,
    draft: { subject: input.subject, opener: sentences[0] ?? "", middle: sentences.slice(1, -1).join(" "), cta: question, full_body: core },
  };
  const questions = {
    opener_grounded: {
      type: "noul",
      instructions: "Does draft.opener use a fact that appears in prospect_evidence, without adding or embellishing detail?",
      criteria: { true: "The detail is supported by an evidence item and not embellished.", false: "The detail is absent from the evidence, contradicted or embellished." },
    },
    opener_relevant: {
      type: "noul",
      instructions: "Is the fact in draft.opener relevant to this person's role or their company's priorities, rather than a generic or personal mention?",
      criteria: { true: "It is a business signal that plausibly relates to their work.", false: "It is generic, flattering or personal, or unrelated to their work." },
    },
    problem_hedged: {
      type: "noul",
      instructions: "Does draft.middle describe a possible business problem without stating an unverified pain, intent or timing as fact?",
      criteria: { true: "Any inferred problem is framed as a possibility.", false: "It asserts the prospect has a problem or intent that the evidence doesn't show." },
    },
    claims_supported: {
      type: "noul",
      instructions: "Are all statements about what Eclipse does or achieves in draft.full_body within approved_product_claims, with no invented results, customers or numbers?",
      criteria: { true: "Every product statement is allowed by the brief.", false: "A product statement is not allowed, overstated or invented." },
    },
    subject_honest: {
      type: "noul",
      instructions: "Does draft.subject accurately represent the email without implying news, familiarity, a reply or urgency that the body doesn't support?",
      criteria: { true: "The subject is accurate and plain.", false: "The subject misleads or uses a trick." },
    },
    cta_kind: {
      type: "choice",
      instructions: "Classify the call to action in draft.cta.",
      criteria: {
        useful_offer: "Offers a specific useful resource, example or analysis.",
        interest: "Asks whether they are interested in the topic.",
        meeting_request: "Asks for a call, meeting or demo.",
        multiple_or_vague: "The ask is unclear or there are competing asks.",
      },
    },
    coherent: {
      type: "noul",
      instructions: "Does draft.full_body connect the opener, the possible problem, what Eclipse does and the question without a gap or contradiction?",
      criteria: { true: "It reads as one connected thought.", false: "A step is missing or the parts don't connect." },
    },
    sounds_human: {
      type: "score",
      instructions: "How much does draft.full_body read like a thoughtful person writing to one specific person?",
      criteria: ["Generic template or obviously machine written", "Mostly generic with some specifics", "Specific and natural", "Specific, natural and clearly written for this one person"],
    },
  };
  const response = await (options.fetchImpl ?? fetch)(JEV_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.TYPESAFE_API_KEY!.trim()}`, "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.TYPESAFE_MODEL?.trim() || "jev-latest", state, questions }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Jev answered ${response.status}.`);
  const answers = ((await response.json()) as { answers?: Record<string, JevAnswer> }).answers ?? {};
  const yes = (id: string, label: string, fix: string): ColdEmailCheck => {
    const value = answers[id]?.noul;
    const known = typeof value === "number";
    return {
      id,
      label,
      pass: known && value >= 0.7,
      note: known ? `${Math.round(value * 100)}% likely yes${value >= 0.5 && value < 0.7 ? ", unsure" : ""}.` : "No answer.",
      fix,
      source: "jev",
    };
  };
  const checks = [
    yes("opener_grounded", "Opener matches the evidence", "Use a fact exactly as it appears in your evidence, or find a verified one."),
    yes("opener_relevant", "Opener is relevant", "Open with a business signal tied to their role, not a compliment or a personal detail."),
    yes("problem_hedged", "Problem framed honestly", "Say the problem may apply ('if', 'may'), rather than telling them they have it."),
    yes("claims_supported", "Eclipse claims allowed", "Keep to what the outreach brief allows and remove invented results or numbers."),
    yes("subject_honest", "Subject is honest", "Make the subject a plain description of what the email is about."),
    yes("coherent", "Reads as one thought", "Connect the signal to the problem, then to what Eclipse does, then to the question."),
  ];
  const kind = answers.cta_kind?.choice;
  checks.push({
    id: "cta_kind",
    label: "Call to action",
    pass: kind === "useful_offer" || kind === "interest" || (kind === "meeting_request" && input.firstTouch === false),
    note: kind ? `Classed as ${kind.replace("_", " ")}.` : "No answer.",
    fix: "End with one easy question that offers something useful.",
    source: "jev",
  });
  const human = answers.sounds_human?.score;
  checks.push({
    id: "sounds_human",
    label: "Sounds like a person",
    pass: typeof human === "number" && human >= 1.8,
    note: typeof human === "number" ? `${human.toFixed(1)} of 3.` : "No answer.",
    fix: "Make it specific to this person and plainer: fewer stock phrases, more of what you actually noticed.",
    source: "jev",
  });
  return checks.map((check) => (check.pass ? { ...check, fix: undefined } : check));
}

export async function checkColdEmail(
  input: { subject: string; body: string; evidence: Evidence[]; firstTouch?: boolean },
  options: { fetchImpl?: typeof fetch } = {},
) {
  const rules = lintColdEmail(input);
  let jev: ColdEmailCheck[] = [];
  let jevError: string | null = null;
  try {
    jev = await judgeColdEmail(input, options);
  } catch (error) {
    jevError = error instanceof Error ? error.message : "Jev didn't answer.";
  }
  const checks = [...rules, ...jev];
  const failed = checks.filter((check) => !check.pass);
  return {
    ready: failed.length === 0,
    checks: checks.map(({ id, label, pass, note, source }) => ({ id, label, pass, note, source })),
    fixes: failed.map((check) => `${check.label}: ${check.fix}`),
    graded: jevConfigured() ? (jevError ? `Jev grading failed (${jevError}); only the rule checks ran.` : "Rule checks and Jev grading.") : "Rule checks only (add TYPESAFE_API_KEY for Jev grading).",
  };
}
