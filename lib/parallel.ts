const DECISIONS_URL = "https://api.parallel.ai/v1/decisions";
const TIMEOUT_MS = 20_000;
const QUESTIONS_MAX = 100;
const QUESTION_CHARS_MAX = 5_000;
const RETRY_PAUSE_MS = 1_500;

export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type DecisionAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number> }
  | { type: "score"; score: number; probabilities: Record<string, number> }
  | { type: "refusal" };

export type DecisionCitation = { url: string; title: string | null; excerpts: string[] };

export type Decision = { answers: Record<string, DecisionAnswer>; citations: DecisionCitation[]; id: string | null };

export class ParallelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParallelError";
  }
}

export function parallelKey(env: Record<string, string | undefined> = process.env) {
  return env.PARALLEL_API_KEY?.trim() || null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function probabilities(value: unknown) {
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record(value))) if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
  return out;
}

function readAnswer(value: unknown): DecisionAnswer {
  const answer = record(value);
  if (answer.type === "noul" && typeof answer.noul === "number" && Number.isFinite(answer.noul)) return { type: "noul", noul: answer.noul };
  if (answer.type === "choice" && typeof answer.choice === "string") return { type: "choice", choice: answer.choice, probabilities: probabilities(answer.probabilities) };
  if (answer.type === "score" && typeof answer.score === "number" && Number.isFinite(answer.score)) {
    return { type: "score", score: answer.score, probabilities: probabilities(answer.probabilities) };
  }
  return { type: "refusal" };
}

function readCitation(value: unknown): DecisionCitation | null {
  const citation = record(value);
  if (typeof citation.url !== "string" || !/^https?:\/\//.test(citation.url)) return null;
  return {
    url: citation.url.slice(0, 1000),
    title: typeof citation.title === "string" ? citation.title.slice(0, 300) : null,
    excerpts: Array.isArray(citation.excerpts) ? citation.excerpts.filter((item): item is string => typeof item === "string") : [],
  };
}

function checkLimits(questions: Record<string, DecisionQuestion>) {
  const names = Object.keys(questions);
  if (names.length > QUESTIONS_MAX) throw new ParallelError(`A web check can ask up to ${QUESTIONS_MAX} questions at once.`);
  for (const name of names) {
    const question = questions[name];
    if (name.length + JSON.stringify(question).length > QUESTION_CHARS_MAX) throw new ParallelError(`The question ${name} is too long for Parallel. Shorten it or its options.`);
    if (question.type === "choice" && (Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 255)) {
      throw new ParallelError(`The question ${name} needs 2 to 255 options.`);
    }
    if (question.type === "score" && (question.criteria.length < 2 || question.criteria.length > 10)) throw new ParallelError(`The question ${name} needs 2 to 10 levels.`);
  }
}

function retryable(status: number) {
  return status === 429 || status >= 500;
}

export async function decide(
  state: Record<string, unknown>,
  questions: Record<string, DecisionQuestion>,
  options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; timeoutMs?: number; excerpts?: boolean; retryPauseMs?: number } = {},
): Promise<Decision> {
  const key = parallelKey(options.env);
  if (!key) throw new ParallelError("Add PARALLEL_API_KEY in Vercel to run web checks.");
  if (Object.keys(questions).length === 0) return { answers: {}, citations: [], id: null };
  checkLimits(questions);
  const send = async () => {
    try {
      return await (options.fetchImpl ?? fetch)(DECISIONS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({ state, questions, ...(options.excerpts === false ? { include_excerpts: false } : {}) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
    } catch {
      return null;
    }
  };
  let response = await send();
  if (!response || retryable(response.status)) {
    await response?.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, options.retryPauseMs ?? RETRY_PAUSE_MS));
    response = await send();
  }
  if (!response) throw new ParallelError("Parallel didn't respond. Try again.");
  if (!response.ok) {
    throw new ParallelError(
      response.status === 401 || response.status === 403
        ? "Parallel rejected the key."
        : response.status === 429
          ? "Parallel is rate limiting. Try again shortly."
          : `Parallel returned ${response.status}.`,
    );
  }
  const body = record(await response.json().catch(() => null));
  const answers: Record<string, DecisionAnswer> = {};
  for (const name of Object.keys(questions)) answers[name] = readAnswer(record(body.answers)[name]);
  const citations = (Array.isArray(body.citations) ? body.citations : []).map(readCitation).filter((item): item is DecisionCitation => item !== null);
  return { answers, citations, id: typeof body.decision_id === "string" ? body.decision_id : null };
}
