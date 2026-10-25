import { CrmError } from "@/lib/crm/errors";
import { generateAgentToken } from "@/lib/crm/tokens";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";

export const MARKET_AGENT_NAME = "Grok Bot";

export type MarketAgentStatus = { connectedAt: string; lastUsedAt: string | null } | null;

export async function marketAgentStatus(actor: UserActor): Promise<MarketAgentStatus> {
  const result = await query<{ connected_at: Date; last_used_at: Date | null }>("select connected_at, last_used_at from private.market_agent_status($1, $2)", [
    actor.workspaceId,
    MARKET_AGENT_NAME,
  ]);
  const row = result.rows[0];
  return row ? { connectedAt: row.connected_at.toISOString(), lastUsedAt: row.last_used_at?.toISOString() ?? null } : null;
}

export async function issueMarketAgentToken(actor: UserActor) {
  if (actor.role !== "owner" && actor.role !== "admin") {
    throw new CrmError("forbidden", "Only an owner or admin can connect Grok Bot.", 403);
  }
  const { token, prefix, hash } = generateAgentToken();
  await query("select private.issue_market_agent($1, $2, $3, $4, $5)", [actor.workspaceId, actor.userId, MARKET_AGENT_NAME, prefix, hash]);
  return { token };
}

export function grokRoutine(mcpUrl: string) {
  return `Every night at 1am UK time, research the market for Eclipse and send what you find to Orbit.

1. Call get_watchlist on the Orbit plugin (${mcpUrl}). It lists the topics, competitors, people, target accounts and sources to watch.
2. Search X and my news sources for the last 24 hours on everything in the watchlist, plus AI visibility, generative engine optimisation (GEO), AI search, content operations and agencies.
3. Keep only what matters to Eclipse's sales and positioning: competitor launches and moves, funding, hires and leadership changes, product news, notable posts by the people on the list, data or research worth quoting, and anything a target account posts or announces that is a reason to contact them now.
4. Call add_market_notes once with up to 30 notes. Each note has: kind (news, post, launch, hire, funding, signal or research), headline (one line), summary (two or three factual sentences, no opinion), url (the original post or article), about (the company or person it concerns, spelled as in the watchlist) and publishedAt (ISO date).
5. Never invent a link or a figure. Skip anything you can't link to. If nothing qualifies, send nothing.`;
}
