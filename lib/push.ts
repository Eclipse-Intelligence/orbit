import webpush from "web-push";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import { query } from "@/lib/db/pool";
import { siteOrigin } from "@/lib/site-url";

export type PushMessage = { title: string; body: string; url: string; tag?: string; badge?: number | null };

export type PushSender = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;

type Keys = { publicKey: string; privateKey: string };

let cached: Promise<Keys> | null = null;

async function loadKeys(): Promise<Keys> {
  const found = await query<{ public_key: string; private_key_cipher: string }>("select * from private.push_key()");
  let row = found.rows[0];
  if (!row) {
    const fresh = webpush.generateVAPIDKeys();
    const saved = await query<{ public_key: string; private_key_cipher: string }>("select * from private.push_key($1, $2)", [
      fresh.publicKey,
      encryptSecret(fresh.privateKey),
    ]);
    row = saved.rows[0];
  }
  return { publicKey: row.public_key, privateKey: decryptSecret(row.private_key_cipher) };
}

export function pushKeys() {
  if (!cached) cached = loadKeys().catch((error) => {
    cached = null;
    throw error;
  });
  return cached;
}

export async function pushPublicKey() {
  return (await pushKeys()).publicKey;
}

function subject(actor: UserActor) {
  const origin = siteOrigin();
  if (origin?.startsWith("https://")) return origin;
  return `mailto:${actor.email || "orbit@geteclipse.co"}`;
}

export async function savePushSubscription(
  actor: UserActor,
  input: { endpoint: unknown; keys?: { p256dh?: unknown; auth?: unknown } },
  userAgent: string | null,
) {
  const endpoint = typeof input.endpoint === "string" ? input.endpoint.trim() : "";
  const p256dh = typeof input.keys?.p256dh === "string" ? input.keys.p256dh : "";
  const auth = typeof input.keys?.auth === "string" ? input.keys.auth : "";
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000 || !p256dh || p256dh.length > 200 || !auth || auth.length > 100) {
    throw new CrmError("invalid_input", "This device couldn't set up notifications. Try again.", 400);
  }
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.push_subscriptions (workspace_id, user_id, endpoint, p256dh, auth, user_agent)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id, endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, last_seen_at = now(), workspace_id = excluded.workspace_id`,
      [actor.workspaceId, actor.userId, endpoint, p256dh, auth, userAgent?.slice(0, 400) ?? null],
    ),
  );
  return { saved: true };
}

export async function removePushSubscription(actor: UserActor, endpoint: string) {
  await withActor(actor, (db) => db.query("delete from crm.push_subscriptions where user_id = $1 and endpoint = $2", [actor.userId, endpoint]));
}

export async function pushToUser(actor: UserActor, message: PushMessage, options: { send?: PushSender } = {}) {
  const subscriptions = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      "select id, endpoint, p256dh, auth from crm.push_subscriptions where user_id = $1 and workspace_id = $2",
      [actor.userId, actor.workspaceId],
    );
    return result.rows;
  });
  if (subscriptions.length === 0) return { sent: 0, removed: 0 };
  const keys = await pushKeys();
  const send: PushSender = options.send ?? ((subscription, payload, sendOptions) => webpush.sendNotification(subscription, payload, sendOptions));
  const payload = JSON.stringify({
    title: message.title.slice(0, 120),
    body: message.body.slice(0, 400),
    url: message.url,
    tag: message.tag?.slice(0, 200),
    badge: message.badge ?? null,
  });
  let sent = 0;
  const gone: string[] = [];
  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await send({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, {
          vapidDetails: { subject: subject(actor), publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 6 * 60 * 60,
          urgency: "high",
          timeout: 10_000,
        });
        sent += 1;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) gone.push(subscription.id);
        else console.error("push failed", status ?? error);
      }
    }),
  );
  if (gone.length) {
    await withActor(actor, (db) => db.query("delete from crm.push_subscriptions where id = any($1::uuid[])", [gone]));
  }
  return { sent, removed: gone.length };
}
