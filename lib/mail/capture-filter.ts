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
  listSenderRulesInDb,
  removeSenderRuleInDb,
  pendingIsFresh,
  signatureOf,
  storeThreadDecision,
  verdictFor,
  workspaceContext,
  type Decision,
  type History,
  type Judged,
  type RelevanceEngine,
  type SenderRule,
  type SkippedCategory,
  type StoredCategory,
  type WorkspaceContext,
} from "@/lib/mail/relevance";
import { refs } from "@/lib/mail/routing";
import { bulkHeaderCategory, type ListedCategory } from "@/lib/mail/senders";
import { mailSourceToken } from "@/lib/mail/sync";

const CAPTURE_SHOWN = 30;
const NOT_SHOWN_LISTED = 50;
const INLINE_MS = 2_500;
const INLINE_CAP = 6;
const INLINE_FINISH_MS = 12_000;
const BACKGROUND_CAP = 25;
const PARALLEL = 4;
const STOP_MARGIN_MS = 1_500;
const CLAIM_SECONDS = 120;

export type SkippedEmail = UnknownEmail & { category: SkippedCategory; engine: RelevanceEngine; reason: string | null; stored: StoredCategory | null };

export type RelevantMail = { shown: UnknownEmail[]; skipped: SkippedEmail[]; pending: UnknownEmail[] };

type Header = { name: string; value: string };

type ClassifyOptions = {
  deadline: number;
  fetchImpl?: typeof fetch;
  headers?: boolean;
  readHeaders?: (item: UnknownEmail) => Promise<Header[] | null>;
};

type Work = { item: UnknownEmail; hint: ListedCategory | null };

const inFlight = new Set<string>();

function sortOut(judged: Judged<UnknownEmail>[], now = Date.now()): RelevantMail {
  const shown: UnknownEmail[] = [];
  const skipped: SkippedEmail[] = [];
  const pending: UnknownEmail[] = [];
  for (const { item, verdict, stored } of judged) {
    if (verdict.state === "shown") shown.push(item);
    else if (verdict.state === "skipped") skipped.push({ ...item, category: verdict.category, engine: verdict.engine, reason: verdict.reason, stored });
    else if (pendingIsFresh(item.at, now)) pending.push(item);
    else shown.push(item);
  }
  return { shown, skipped, pending };
}

function graphHeaders(actor: UserActor, items: UnknownEmail[], fetchImpl?: typeof fetch) {
  const tokens = new Map<string, Promise<string>>();
  let providers: Promise<Map<string, string>> | null = null;
  const lookup = () =>
    (providers ??= withActor(actor, async (db) => {
      const result = await db.query<{ id: string; provider_message_id: string }>(
        "select id, provider_message_id from crm.mail_messages where id = any($1::uuid[]) and user_id = $2",
        [items.map((item) => item.messageId), actor.userId],
      );
      return new Map(result.rows.map((row) => [row.id, row.provider_message_id]));
    }));
  return async (item: UnknownEmail) => {
    const provider = (await lookup()).get(item.messageId);
    if (!provider) return null;
    const sourceId = item.key.slice(0, item.key.indexOf("|"));
    if (!tokens.has(sourceId)) tokens.set(sourceId, mailSourceToken(actor, sourceId, fetchImpl));
    return fetchMicrosoftHeaders(await tokens.get(sourceId)!, provider, fetchImpl);
  };
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

async function store(actor: UserActor, item: UnknownEmail, decision: Decision) {
  await withActor(actor, async (db) => {
    await storeThreadDecision(db, actor, item, decision);
    await cacheSenderDecision(db, actor, item.workspaceId, item.email, decision);
  });
}

async function storeFailed(actor: UserActor, item: UnknownEmail) {
  await withActor(actor, (db) => storeThreadDecision(db, actor, item, { category: null, engine: "failed", confidence: null, reason: null })).catch((error) =>
    console.error("Couldn't store a Capture sorting failure", error instanceof Error ? error.message : error),
  );
}

export async function classifyItems(actor: UserActor, actors: UserActor[], work: Work[], options: ClassifyOptions) {
  const mine = work.filter(({ item }) => !inFlight.has(item.key));
  if (mine.length === 0) return 0;
  for (const { item } of mine) inFlight.add(item.key);
  const contexts = new Map<string, Promise<WorkspaceContext>>();
  const reader = options.readHeaders ?? (options.headers ? graphHeaders(actor, mine.map(({ item }) => item), options.fetchImpl) : null);
  const byWorkspace = new Map<string, Work[]>();
  for (const entry of mine) byWorkspace.set(entry.item.workspaceId, [...(byWorkspace.get(entry.item.workspaceId) ?? []), entry]);
  let decided = 0;
  try {
    for (const [workspaceId, group] of byWorkspace) {
      const target = actors.find((entry) => entry.workspaceId === workspaceId);
      if (!target) continue;
      if (!contexts.has(workspaceId)) contexts.set(workspaceId, workspaceContext(target));
      let context: WorkspaceContext;
      let history: Map<string, History>;
      let bodies: Map<string, string | null>;
      try {
        [context, history, bodies] = await Promise.all([
          contexts.get(workspaceId)!,
          withActor(target, (db) => historyInDb(db, actor, workspaceId, group.map(({ item }) => item.email))),
          withActor(actor, async (db) => {
            const result = await db.query<{ id: string; body_text: string | null }>(
              "select id, left(coalesce(body_text, ''), 20000) as body_text from crm.mail_messages where id = any($1::uuid[]) and user_id = $2",
              [group.map(({ item }) => item.messageId), actor.userId],
            );
            return new Map(result.rows.map((row) => [row.id, row.body_text]));
          }),
        ]);
      } catch (error) {
        console.error("Reading Capture email context failed", error instanceof Error ? error.message : error);
        for (const { item } of group) await storeFailed(actor, item);
        continue;
      }
      const shared = new Map<string, Promise<Decision>>();
      await inParallel(group, PARALLEL, async ({ item, hint }) => {
        if (Date.now() > options.deadline - STOP_MARGIN_MS) return;
        try {
          const state = decisionState(
            context,
            {
              fromName: item.name,
              fromAddress: item.email,
              receivedBy: item.address,
              subject: item.subject,
              snippet: item.snippet,
              signature: signatureOf(bodies.get(item.messageId) ?? null),
              listedAs: hint,
            },
            history.get(item.email),
          );
          let decision: Decision | null = null;
          if (reader && !state.history.userHasWrittenToSender) {
            const headers = await reader(item).catch(() => null);
            const category = headers ? bulkHeaderCategory(headers) : null;
            if (category) decision = { category, engine: "headers", confidence: null, reason: null };
          }
          if (!decision) {
            const key = `${item.workspaceId}|${item.email}`;
            const earlier = shared.get(key);
            const reused = earlier ? await earlier : null;
            if (reused && verdictFor(reused, reused.engine).state === "shown" && reused.engine !== "failed") {
              decision = reused;
            } else {
              const own = decideRelevance(state, { deadline: options.deadline, fetchImpl: options.fetchImpl });
              if (!earlier) shared.set(key, own);
              decision = await own;
            }
          }
          await store(actor, item, decision);
          if (decision.engine !== "failed") decided += 1;
        } catch (error) {
          console.error("Sorting a Capture email failed", error instanceof Error ? error.message : error);
          await storeFailed(actor, item);
        }
      });
    }
  } finally {
    for (const { item } of mine) inFlight.delete(item.key);
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
  const pending = judged.filter((entry) => entry.verdict.state === "pending");
  if (!options.inline || pending.length === 0) return sortOut(judged, now);
  const work = classifyItems(
    actor,
    actors,
    pending.slice(0, INLINE_CAP).map(({ item, hint }) => ({ item, hint })),
    { deadline: Date.now() + INLINE_FINISH_MS, fetchImpl: options.fetchImpl },
  ).catch((error) => {
    console.error("Sorting Capture email failed", error instanceof Error ? error.message : error);
    return 0;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([work.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), INLINE_MS)))]);
  clearTimeout(timer);
  if (!finished) keepGoing(work);
  return sortOut(await withActor(actor, (db) => judgeInDb(db, actor, raw, now)), now);
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

async function claimRun(actor: UserActor, gapSeconds: number) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ started_at: string }>(
      `insert into crm.mail_relevance_runs (user_id, started_at, running_until) values ($1, now(), now() + make_interval(secs => $2))
       on conflict (user_id) do update set started_at = now(), running_until = excluded.running_until
       where crm.mail_relevance_runs.running_until <= now() and crm.mail_relevance_runs.started_at <= now() - make_interval(secs => $3)
       returning started_at::text`,
      [actor.userId, CLAIM_SECONDS, gapSeconds],
    );
    return result.rows[0]?.started_at ?? null;
  });
}

async function releaseRun(actor: UserActor, startedAt: string) {
  await withActor(actor, (db) =>
    db.query("update crm.mail_relevance_runs set running_until = now() where user_id = $1 and started_at = $2::timestamptz", [actor.userId, startedAt]),
  ).catch(() => undefined);
}

export async function classifyCapture(
  actor: UserActor,
  options: {
    deadline?: number;
    budgetMs?: number;
    limit?: number;
    fetchImpl?: typeof fetch;
    gapSeconds?: number;
    readHeaders?: (item: UnknownEmail) => Promise<Header[] | null>;
  },
) {
  const deadline = options.deadline ?? Date.now() + (options.budgetMs ?? 20_000);
  const claimed = await claimRun(actor, options.gapSeconds ?? 0);
  if (!claimed) return { decided: 0, waiting: 0, skipped: true };
  try {
    const actors = await workspaceActors(actor);
    const raw = await unknownMail(actor, actors);
    const judged = await withActor(actor, (db) => judgeInDb(db, actor, raw));
    const copies = judged.filter((entry) => entry.copy);
    if (copies.length) {
      await withActor(actor, async (db) => {
        for (const entry of copies) {
          await db.query("savepoint relevance_copy");
          try {
            await storeThreadDecision(db, actor, entry.item, entry.copy!);
            await db.query("release savepoint relevance_copy");
          } catch (error) {
            await db.query("rollback to savepoint relevance_copy");
            console.error("Couldn't store a Capture decision", error instanceof Error ? error.message : error);
          }
        }
      }).catch((error) => console.error("Couldn't store Capture decisions", error instanceof Error ? error.message : error));
    }
    const todo = judged.filter((entry) => entry.verdict.state === "pending" || entry.retry).slice(0, options.limit ?? BACKGROUND_CAP);
    const decided = await classifyItems(
      actor,
      actors,
      todo.map(({ item, hint }) => ({ item, hint })),
      { deadline, fetchImpl: options.fetchImpl, headers: true, readHeaders: options.readHeaders },
    );
    return { decided, waiting: todo.length - decided, skipped: false };
  } finally {
    await releaseRun(actor, claimed);
  }
}

export async function listSenderRules(actor: UserActor): Promise<SenderRule[]> {
  return withActor(actor, (db) => listSenderRulesInDb(db, actor));
}

export async function removeSenderRule(actor: UserActor, sender: string) {
  await withActor(actor, (db) => removeSenderRuleInDb(db, actor, sender));
  return { sender };
}

export async function listUnknownMail(
  actor: UserActor,
  now = Date.now(),
  known?: { actors: UserActor[]; emails: UnknownEmail[]; skipped: SkippedEmail[]; pending?: UnknownEmail[] },
) {
  const actors = known?.actors ?? (await workspaceActors(actor));
  const mail = known ? { shown: known.emails, skipped: known.skipped, pending: known.pending ?? [] } : await relevantMailOnce(actor, actors, now);
  const here = mail.shown.filter((row) => row.workspaceId === actor.workspaceId);
  const skipped = mail.skipped.filter((row) => row.workspaceId === actor.workspaceId);
  return {
    emails: here.slice(0, CAPTURE_SHOWN),
    total: here.length,
    notShown: skipped.slice(0, NOT_SHOWN_LISTED),
    notShownTotal: skipped.length,
    sorting: mail.pending.filter((row) => row.workspaceId === actor.workspaceId).length,
    workspaces: refs(actors),
  };
}
