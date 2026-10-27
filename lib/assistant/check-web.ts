import { decide, ParallelError, type DecisionAnswer, type DecisionQuestion } from "@/lib/parallel";

const MAX_QUESTIONS = 20;
const KEY = /^[a-z][a-zA-Z0-9_]{0,39}$/;

type Asked = { key: string; type: "yes_no" | "choice" | "score"; question: string; options: string[] };

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function percent(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : null;
}

function readQuestions(value: unknown): Asked[] | string {
  const list = Array.isArray(value) ? value : [];
  if (list.length === 0) return "Ask at least one question.";
  if (list.length > MAX_QUESTIONS) return `Ask up to ${MAX_QUESTIONS} questions at a time.`;
  const asked: Asked[] = [];
  for (const raw of list) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const key = text(item.key, 40);
    if (!KEY.test(key) || asked.some((entry) => entry.key === key)) return `Give each question its own short key, such as has_funding.`;
    const type = item.type === "choice" || item.type === "score" ? item.type : "yes_no";
    const question = text(item.question, 2000);
    if (!question) return `${key}: write the question.`;
    const options = Array.isArray(item.options) ? item.options.map((option) => text(option, 500)).filter(Boolean) : [];
    if (type === "choice" && (options.length < 2 || options.length > 50)) return `${key}: give 2 to 50 options.`;
    if (type === "score" && (options.length < 2 || options.length > 10)) return `${key}: give 2 to 10 levels, lowest first.`;
    asked.push({ key, type, question, options: type === "yes_no" ? [] : options });
  }
  return asked;
}

function toParallel(asked: Asked): DecisionQuestion {
  if (asked.type === "yes_no") return { type: "noul", instructions: asked.question };
  if (asked.type === "score") return { type: "score", instructions: asked.question, criteria: asked.options };
  return {
    type: "choice",
    instructions: `${asked.question} Select unknown when the evidence doesn't settle it.`,
    criteria: { ...Object.fromEntries(asked.options.map((option, index) => [`o${index}`, option])), unknown: "The evidence doesn't settle it." },
  };
}

function fromParallel(asked: Asked, answer: DecisionAnswer | undefined) {
  if (!answer || answer.type === "refusal") return { question: asked.question, answer: null, note: "No answer. Treat it as unknown, not as no." };
  if (asked.type === "yes_no" && answer.type === "noul") return { question: asked.question, likelihood: percent(answer.noul) };
  if (asked.type === "score" && answer.type === "score") {
    return { question: asked.question, score: Math.round(answer.score * 10) / 10, of: asked.options.length - 1, levels: asked.options };
  }
  if (asked.type === "choice" && answer.type === "choice") {
    const index = answer.choice.startsWith("o") ? Number(answer.choice.slice(1)) : -1;
    return { question: asked.question, choice: asked.options[index] ?? "unknown", confidence: percent(answer.probabilities[answer.choice]) };
  }
  return { question: asked.question, answer: null, note: "No answer. Treat it as unknown, not as no." };
}

export async function checkWeb(args: Record<string, unknown>, options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {}) {
  const about = text(args.about, 1000);
  if (!about) return { error: "Say who or what the questions are about." };
  const asked = readQuestions(args.questions);
  if (typeof asked === "string") return { error: asked };
  try {
    const decision = await decide(
      { about, today: new Date().toISOString().slice(0, 10) },
      Object.fromEntries(asked.map((item) => [item.key, toParallel(item)])),
      options,
    );
    return {
      answers: Object.fromEntries(asked.map((item) => [item.key, fromParallel(item, decision.answers[item.key])])),
      sources: decision.citations.map((citation) => ({ url: citation.url, title: citation.title, excerpts: citation.excerpts })),
      note: "Likelihoods are estimates from the sources found. Sources are for all the answers together.",
    };
  } catch (error) {
    return { error: error instanceof ParallelError ? error.message : "The web check failed." };
  }
}
