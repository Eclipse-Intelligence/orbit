import { sendAlert } from "@/lib/alerts";
import { memberActor } from "@/lib/crm/conversations";
import { query } from "@/lib/db/pool";
import { personName } from "@/lib/mail/format";
import type { MailAddress } from "@/lib/mail/types";
import type { PushSender } from "@/lib/push";

type OwnerRow = Parameters<typeof memberActor>[0] & {
  subject: string | null;
  recipients: MailAddress[] | null;
  opens: number;
  notify_reads: boolean;
  source_id: string | null;
  thread_key: string | null;
};

export async function alertFirstRead(trackingId: string, options: { send?: PushSender } = {}) {
  const found = await query<OwnerRow>("select * from private.mail_open_owner($1)", [trackingId]);
  const row = found.rows[0];
  if (!row || !row.notify_reads || row.opens !== 1) return { sent: 0 };
  const recipients = row.recipients ?? [];
  const who = recipients.length === 1 ? personName(recipients[0]) : "Someone";
  const url =
    row.source_id && row.thread_key ? `/mail?view=sent&thread=${encodeURIComponent(`${row.source_id}|${row.thread_key}`)}` : "/mail?view=sent";
  return sendAlert(
    memberActor(row),
    { key: `read:${trackingId}`, title: `${who} read your email`, body: row.subject?.trim() || "(no subject)", url, tag: `read:${trackingId}` },
    options,
  );
}
