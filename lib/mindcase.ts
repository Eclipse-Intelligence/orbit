import { withActor } from "@/lib/crm/context";
import type { Actor } from "@/lib/crm/types";

const API = "https://api.mindcase.co/v1";
const POLL_MS = 2_000;
const DEFAULT_LIMIT_USD = 20;

export const MINDCASE_PRICES = {
  "linkedin/profiles": 0.004,
  "linkedin/companies": 0.004,
  "linkedin/posts": 0.002,
  "twitter/profiles": 0.0005,
  "twitter/tweets": 0.00025,
} as const;

export type MindcaseAgent = keyof typeof MINDCASE_PRICES;
type Row = Record<string, unknown>;
type RunReply = { job_id?: string; status?: string; data?: Row[]; error?: string; detail?: string };

export class MindcaseError extends Error {}

export function mindcaseConfigured() {
  return Boolean(process.env.MINDCASE_API_KEY?.trim());
}

export function monthlyLimitUsd() {
  const value = Number(process.env.MINDCASE_MONTHLY_LIMIT_USD);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_LIMIT_USD;
}

async function spentThisMonth(actor: Actor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ total: string | null }>(
      `select sum(cost_usd) as total from crm.data_usage
       where workspace_id = $1 and provider = 'mindcase' and created_at >= date_trunc('month', now())`,
      [actor.workspaceId],
    );
    return Number(result.rows[0]?.total ?? 0);
  });
}

async function recordUsage(actor: Actor, agent: MindcaseAgent, rows: number, source: string) {
  await withActor(actor, (db) =>
    db.query(
      "insert into crm.data_usage (workspace_id, provider, agent, rows, cost_usd, user_id, source) values ($1, 'mindcase', $2, $3, $4, $5, $6)",
      [actor.workspaceId, agent, rows, Math.round(rows * MINDCASE_PRICES[agent] * 100_000) / 100_000, actor.type === "user" ? actor.userId : null, source.slice(0, 80)],
    ),
  );
}

async function call(path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<RunReply> {
  const response = await fetchImpl(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${process.env.MINDCASE_API_KEY!.trim()}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(65_000),
  });
  const body = (await response.json().catch(() => ({}))) as RunReply;
  if (response.status === 402) throw new MindcaseError("The Mindcase wallet is empty. Top it up at mindcase.co.");
  if (response.status === 401) throw new MindcaseError("The Mindcase key isn't valid. Check MINDCASE_API_KEY.");
  if (!response.ok) throw new MindcaseError(`Mindcase answered ${response.status}${body.detail || body.error ? `: ${String(body.detail ?? body.error).slice(0, 200)}` : ""}.`);
  return body;
}

export async function runMindcase(
  actor: Actor,
  agent: MindcaseAgent,
  params: Record<string, unknown>,
  options: { source: string; expectedRows: number; fetchImpl?: typeof fetch; deadline?: number },
): Promise<Row[]> {
  if (!mindcaseConfigured()) throw new MindcaseError("Mindcase isn't set up. Add MINDCASE_API_KEY.");
  const limit = monthlyLimitUsd();
  const spent = await spentThisMonth(actor);
  if (spent + options.expectedRows * MINDCASE_PRICES[agent] > limit) {
    throw new MindcaseError(`This month's Mindcase spend ($${spent.toFixed(2)}) has reached the $${limit} limit. Raise MINDCASE_MONTHLY_LIMIT_USD to allow more.`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = options.deadline ?? Date.now() + 90_000;
  let reply = await call(`/data/${agent}/run?wait=true`, { method: "POST", body: JSON.stringify({ params }) }, fetchImpl);
  while (reply.status !== "completed" && reply.job_id && !["failed", "cancelled", "rejected_balance"].includes(reply.status ?? "")) {
    if (Date.now() + POLL_MS > deadline) throw new MindcaseError("Mindcase is still working on that. Try again in a minute.");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    reply = await call(`/jobs/${encodeURIComponent(reply.job_id)}/results`, { method: "GET" }, fetchImpl);
  }
  if (reply.status === "rejected_balance") throw new MindcaseError("The Mindcase wallet is empty. Top it up at mindcase.co.");
  if (reply.status !== "completed") throw new MindcaseError(`The Mindcase lookup ${reply.status ?? "failed"}.`);
  const rows = Array.isArray(reply.data) ? reply.data : [];
  await recordUsage(actor, agent, rows.length, options.source).catch(() => undefined);
  return rows;
}

function text(value: unknown, max = 600) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function slimRole(entry: unknown) {
  if (!entry || typeof entry !== "object") return null;
  const role = entry as Row;
  const company = role.company && typeof role.company === "object" ? text((role.company as Row).name, 120) : text(role.company ?? role.companyName, 120);
  return {
    title: text(role.title ?? role.position, 160),
    company,
    from: text(role.startDate ?? role.start ?? role.dateRange ?? role.duration, 60),
    to: text(role.endDate ?? role.end, 60),
    current: role.current === true || role.isCurrent === true || /present/i.test(String(role.endDate ?? role.end ?? role.dateRange ?? role.duration ?? "")) || undefined,
  };
}

export function slimLinkedInProfile(row: Row) {
  const experience = Array.isArray(row.experience) ? row.experience.slice(0, 5).map(slimRole).filter(Boolean) : [];
  return {
    url: text(row.profileUrl, 300),
    name: text([row.firstName, row.lastName].filter(Boolean).join(" ") || row.fullName, 160),
    headline: text(row.headline, 300),
    location: [row.city, row.state, row.country].filter((part) => typeof part === "string" && part).join(", ") || null,
    about: text(row.about, 800),
    followers: typeof row.followers === "number" ? row.followers : null,
    openToWork: row.openToWork === true,
    experience,
  };
}

export function slimLinkedInCompany(row: Row) {
  return {
    url: text(row.linkedinUrl, 300),
    name: text(row.companyName, 200),
    tagline: text(row.tagline, 300),
    description: text(row.description, 1200),
    website: text(row.website, 300),
    industry: text(row.industry, 120),
    employees: row.employeeCount ?? row.employeeCountRange ?? null,
    followers: typeof row.followers === "number" ? row.followers : null,
    founded: row.foundedYear ?? null,
    headquarters: [row.hqCity, row.hqState, row.hqCountry].filter((part) => typeof part === "string" && part).join(", ") || null,
    specialities: Array.isArray(row.specialities) ? row.specialities.slice(0, 12) : null,
  };
}

export function slimLinkedInPost(row: Row) {
  return {
    url: text(row.postUrl, 300),
    posted: text(row.postedDate, 60),
    author: text(row.authorName, 160),
    text: text(row.postText, 900),
    reactions: row.reactions ?? null,
    comments: row.comments ?? null,
  };
}

export function slimXProfile(row: Row) {
  return {
    url: text(row.profileUrl, 300),
    handle: text(row.username, 80),
    name: text(row.displayName, 160),
    bio: text(row.bio, 500),
    location: text(row.location, 160),
    website: text(row.website, 300),
    followers: row.followers ?? null,
    tweets: row.tweets ?? null,
  };
}

export function slimTweet(row: Row) {
  return {
    url: text(row.tweetUrl, 300),
    posted: text(row.postedDate, 60),
    text: text(row.tweetText, 600),
    likes: row.likes ?? null,
    replies: row.replies ?? null,
    retweets: row.retweets ?? null,
  };
}
