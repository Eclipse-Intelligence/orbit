import { syncCalendar } from "@/lib/crm/calendar";
import { insertFeedAccount } from "@/lib/crm/calendar-accounts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { encryptSecret } from "@/lib/crypto/secret";
import { assertPublicHost, FeedError, feedHost, feedUrlHash, normalizeFeedUrl, type Lookup } from "@/lib/ical/fetch";

export const FEED_DUPLICATE = "That calendar link is already added.";

function feedLabel(value: string | null | undefined) {
  const trimmed = value?.replace(/\s+/g, " ").trim() ?? "";
  return trimmed ? trimmed.slice(0, 200) : null;
}

export async function addCalendarFeed(
  actor: UserActor,
  input: { url: string; name?: string | null },
  options: { feedFetch?: typeof fetch; lookup?: Lookup; now?: number } = {},
) {
  let url: URL;
  try {
    url = normalizeFeedUrl(input.url);
    await assertPublicHost(url.hostname, options.lookup);
  } catch (error) {
    throw new CrmError(
      "invalid_input",
      error instanceof FeedError ? error.message : "That calendar link can't be used.",
      400,
      { field: "url" },
    );
  }
  const host = feedHost(url);
  const label = feedLabel(input.name);
  const accountId = await withActor(actor, (db) =>
    insertFeedAccount(db, actor, {
      urlCipher: encryptSecret(url.toString()),
      urlHash: feedUrlHash(url),
      host,
      label,
    }),
  );
  if (!accountId) throw new CrmError("conflict", FEED_DUPLICATE, 409, { field: "url" });
  const result = await syncCalendar(actor, {
    force: true,
    accountId,
    feedFetch: options.feedFetch,
    lookup: options.lookup,
    now: options.now,
  });
  const state = await withActor(actor, async (db) => {
    const found = await db.query<{ last_synced_at: Date | string | null; name: string | null }>(
      `select a.last_synced_at, c.name
       from crm.calendar_accounts a
       left join crm.calendars c on c.account_id = a.id
       where a.id = $1`,
      [accountId],
    );
    return found.rows[0] ?? null;
  });
  if (result.error && !state?.last_synced_at) {
    await withActor(actor, (db) =>
      db.query("delete from crm.calendar_accounts where id = $1 and user_id = $2 and provider = 'ics'", [
        accountId,
        actor.userId,
      ]),
    );
    throw new CrmError("invalid_input", result.error, 400, { field: "url" });
  }
  return { id: accountId, name: state?.name ?? label ?? host, host };
}
