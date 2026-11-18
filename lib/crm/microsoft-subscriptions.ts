import { withActor } from "@/lib/crm/context";
import { currentToken, type StoredTokens } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { deleteGraphSubscription } from "@/lib/microsoft/subscriptions";

const RELEASE_BUDGET_MS = 10_000;

export type SubscriptionOwner = { connectionId: string } | { accountId: string };

function column(owner: SubscriptionOwner) {
  return "connectionId" in owner ? "connection_id" : "account_id";
}

function ownerId(owner: SubscriptionOwner) {
  return "connectionId" in owner ? owner.connectionId : owner.accountId;
}

export async function subscriptionsOfInDb(db: Db, actor: UserActor, owner: SubscriptionOwner) {
  const result = await db.query<{ id: string }>(
    `select graph_subscription_id as id from crm.mail_sources where ${column(owner)} = $1 and user_id = $2 and graph_subscription_id is not null
     union
     select graph_subscription_id as id from crm.calendars where ${column(owner)} = $1 and user_id = $2 and graph_subscription_id is not null`,
    [ownerId(owner), actor.userId],
  );
  return result.rows.map((row) => row.id);
}

export async function forgetSubscriptionsInDb(db: Db, actor: UserActor, owner: SubscriptionOwner) {
  await db.query(
    `update crm.mail_sources set graph_subscription_id = null, graph_subscription_expires_at = null, graph_client_state = null
     where ${column(owner)} = $1 and user_id = $2`,
    [ownerId(owner), actor.userId],
  );
  await db.query(
    `update crm.calendars set graph_subscription_id = null, graph_subscription_expires_at = null, graph_client_state = null
     where ${column(owner)} = $1 and user_id = $2`,
    [ownerId(owner), actor.userId],
  );
}

export async function readSubscriptions(actor: UserActor, owner: SubscriptionOwner) {
  return withActor(actor, (db) => subscriptionsOfInDb(db, actor, owner));
}

export async function releaseSubscriptions(ids: string[], tokens: StoredTokens | null, options: { fetchImpl?: typeof fetch } = {}) {
  if (ids.length === 0 || !tokens || (!tokens.refreshTokenCipher && !tokens.accessTokenCipher)) return 0;
  const deadline = Date.now() + RELEASE_BUDGET_MS;
  let released = 0;
  try {
    const token = await currentToken(tokens, options.fetchImpl ?? fetch);
    for (const id of ids) {
      if (deadline - Date.now() < 1_000) break;
      await deleteGraphSubscription(token.accessToken, id, { fetchImpl: options.fetchImpl, deadline })
        .then(() => {
          released += 1;
        })
        .catch((error) => console.error("Couldn't remove a Microsoft subscription", error instanceof Error ? error.message : error));
    }
  } catch (error) {
    console.error("Couldn't remove Microsoft subscriptions", error instanceof Error ? error.message : error);
  }
  return released;
}
