import { after } from "next/server";
import { cache } from "react";
import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { workspaceActors } from "@/lib/crm/workspaces";
import { unknownMail, unknownMailOnce, type UnknownEmail } from "@/lib/mail/filing";
import { fetchMicrosoftHeaders } from "@/lib/mail/microsoft";
import {
  cacheSenderDecision,
  decideRelevance,
  decisionState,
  historyInDb,
  judgeInDb,
  signatureOf,
  storeThreadDecision,
  workspaceContext,
  type Decision,
  type Judged,
  type RelevanceEngine,
  type SkippedCategory,
  type WorkspaceContext,
} from "@/lib/mail/relevance";
import { refs } from "@/lib/mail/routing";
import { bulkHeaderCategory } from "@/lib/mail/senders";
import { mailSourceToken } from "@/lib/mail/sync";

const CAPTURE_SHOWN = 30;
const NOT_SHOWN_LISTED = 50;
const INLINE_MS = 2_500;
const INLINE_CAP = 6;
const INLINE_FINISH_MS = 12_000;
const BACKGROUND_CAP = 25;
const PARALLEL = 4;
const STOP_MARGIN_MS = 1_500;

export type SkippedEmail = UnknownEmail & { category: SkippedCategory; engine: RelevanceEngine; reason: string | null };

export type RelevantMail = { shown: UnknownEmail[]; skipped: SkippedEmail[]; pending: string[] };

type ClassifyOptions = { deadline: number; fetchImpl?: typeof fetch; headers?: boolean };

function sortOut(judged: Judged<UnknownEmail>[]): RelevantMail {
  const shown: UnknownEmail[] = [];
  const skipped: SkippedEmail[] = [];
  const pending: string[] = [];
  for (const { item, verdict } of judged) {
    if (verdict.state === "shown") shown.push(item);
    else if (verdict.state === "skipped") skipped.push({ ...item, category: verdict.category, engine: verdict.engine, reason: verdict.reason });
    else pending.push(item.key);
  }
  return { shown, skipped, pending };
}

async function headerDecision(actor: UserActor, item: UnknownEmail, tokens: Map<string, Promise<string>>, fetchImpl?: typeof fetch): Promise<Decision | null> {
  const sourceId = item.key.slice(0, item.key.indexOf("|"));
  const provider = await withActor(actor, async (db) => {
    const result = await db.query<{ provider_message_id: string }>("select provider_message_id from crm.mail_messages where id = $1 and user_id = $2", [item.messageId, actor.userId]);
    return result.rows[0]?.provider_message_id ?? null;
  });
  if (!provider) return null;
  if (!tokens.has(sourceId)) tokens.set(sourceId, mailSourceToken(actor, sourceId, fetchImpl));
  const category = bulkHeaderCategory(await fetchMicrosoftHeaders(await tokens.get(sourceId)!, provider, fetchImpl));
  return category ? { category, engine: "headers", confidence: null, reason: null } : null;
}

async function inParallel<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  });
  await Promise.all(lanes);
}

export async function classifyItems(actor: UserActor, actors: UserActor[], items: UnknownEmail[], options: ClassifyOptions) {
  if (items.length === 0) return 0;
  const contexts = new Map<string, Promise<WorkspaceContext>>();
  const tokens = new Map<string, Promise<string>>();
  const byWorkspace = new Map<string, UnknownEmail[]>();
  for (const item of items) byWorkspace.set(item.workspaceId, [...(byWorkspace.get(item.workspaceId) ?? []), item]);
  let decided = 0;
  for (const [workspaceId, group] of byWorkspace) {
    const target = actors.find((entry) => entry.workspaceId === workspaceId);
    if (!target) continue;
    if (!contexts.has(workspaceId)) contexts.set(workspaceId, workspaceContext(target));
    const [context, history, bodies] = await Promise.all([
      contexts.get(workspaceId)!,
      withActor(target, (db) => historyInDb(db, actor, workspaceId, group.map((item) => item.email))),
      withActor(actor, async (db) => {
        const result = await db.query<{ id: string; body_text: string | null }>(
          "select id, right(coalesce(body_text, ''), 6000) as body_text from crm.mail_messages where id = any($1::uuid[]) and user_id = $2",
          [group.map((item) => item.messageId), actor.userId],
        );
        return new Map(result.rows.map((row) => [row.id, row.body_text]));
      }),
    ]);
    await inParallel(group, PARALLEL, async (item) => {
      if (Date.now() > options.deadline - STOP_MARGIN_MS) return;
      const state = decisionState(
        context,
        { fromName: item.name, fromAddress: item.email, receivedBy: item.address, subject: item.subject, snippet: item.snippet, signature: signatureOf(bodies.get(item.messageId) ?? null) },
        history.get(item.email),
      );
      let decision: Decision | null = null;
      if (options.headers && !state.history.userHasWrittenToSender) {
        decision = await headerDecision(actor, item, tokens, options.fetchImpl).catch(() => null);
      }
      decision ??= await decideRelevance(state, { deadline: options.deadline, fetchImpl: options.fetchImpl });
      const final = decision;
      await withActor(actor, async (db) => {
        await storeThreadDecision(db, actor, item, final);
        if (final.engine === "jev" || final.engine === "haiku" || final.engine === "headers") await cacheSenderDecision(db, actor, item.workspaceId, item.email, final);
      });
      decided += 1;
    });
  }
  return decided;
}

function keepGoing(work: Promise<unknown>) {
  try {
    after(() => work.catch(() => undefined));
  } catch {
    work.catch(() => undefined);
  }
}

export async function relevantMail(actor: UserActor, actors: UserActor[], now = Date.now(), options: { inline?: boolean; fetchImpl?: typeof fetch } = {}): Promise<RelevantMail> {
  const raw = await unknownMailOnce(actor, actors, now);
  const judged = await withActor(actor, (db) => judgeInDb(db, actor, raw, now));
  const pending = judged.filter((entry) => entry.verdict.state === "pending").map((entry) => entry.item);
  if (!options.inline || pending.length === 0) return sortOut(judged);
  const work = classifyItems(actor, actors, pending.slice(0, INLINE_CAP), { deadline: Date.now() + INLINE_FINISH_MS, fetchImpl: options.fetchImpl }).catch((error) => {
    console.error("Sorting Capture email failed", error instanceof Error ? error.message : error);
    return 0;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([work.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), INLINE_MS)))]);
  clearTimeout(timer);
  if (!finished) keepGoing(work);
  return sortOut(await withActor(actor, (db) => judgeInDb(db, actor, raw, now)));
}

const requestRelevant = cache(() => new Map<string, Promise<RelevantMail>>());

export function relevantMailOnce(actor: UserActor, actors: UserActor[], now = Date.now(), options: { inline?: boolean } = {}) {
  const store = requestRelevant();
  const key = `${actor.userId}|${actors.map((item) => item.workspaceId).join(",")}|${options.inline ? "inline" : ""}`;
  const found = store.get(key);
  if (found) return found;
  const pending = relevantMail(actor, actors, now, options);
  store.set(key, pending);
  pending.catch(() => store.delete(key));
  return pending;
}

export async function classifyCapture(actor: UserActor, options: { deadline?: number; budgetMs?: number; limit?: number; fetchImpl?: typeof fetch }) {
  const deadline = options.deadline ?? Date.now() + (options.budgetMs ?? 20_000);
  const actors = await workspaceActors(actor);
  const raw = await unknownMail(actor, actors);
  const judged = await withActor(actor, (db) => judgeInDb(db, actor, raw));
  const copies = judged.filter((entry) => entry.copy);
  if (copies.length) {
    await withActor(actor, async (db) => {
      for (const entry of copies) await storeThreadDecision(db, actor, entry.item, entry.copy!);
    });
  }
  const todo = judged.filter((entry) => entry.verdict.state === "pending" || entry.retry).slice(0, options.limit ?? BACKGROUND_CAP);
  const decided = await classifyItems(
    actor,
    actors,
    todo.map((entry) => entry.item),
    { deadline, fetchImpl: options.fetchImpl, headers: true },
  );
  return { decided, waiting: todo.length - decided };
}

export async function listUnknownMail(
  actor: UserActor,
  now = Date.now(),
  known?: { actors: UserActor[]; emails: UnknownEmail[]; skipped: SkippedEmail[] },
) {
  const actors = known?.actors ?? (await workspaceActors(actor));
  const mail = known ? { shown: known.emails, skipped: known.skipped } : await relevantMailOnce(actor, actors, now);
  const here = mail.shown.filter((row) => row.workspaceId === actor.workspaceId);
  const skipped = mail.skipped.filter((row) => row.workspaceId === actor.workspaceId);
  return {
    emails: here.slice(0, CAPTURE_SHOWN),
    total: here.length,
    notShown: skipped.slice(0, NOT_SHOWN_LISTED),
    notShownTotal: skipped.length,
    workspaces: refs(actors),
  };
}
