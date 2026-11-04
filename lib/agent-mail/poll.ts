import { startAgentMailJob } from "@/lib/agent-mail/jobs";
import { noteMailboxError } from "@/lib/agent-mail/mailbox";
import { storeAgentMessage, type RawMessage } from "@/lib/agent-mail/receive";
import { query } from "@/lib/db/pool";
import { MachineMailError, getMessage, listRecentMessages, machineMailConfigured } from "@/lib/machinemail";

export const POLL_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const FETCHES_PER_RUN = 10;

const LABEL_EVENTS: [string, string][] = [
  ["QUARANTINE", "message.received.quarantined"],
  ["BLOCKED", "message.received.blocked"],
  ["SPAM", "message.received.spam"],
  ["UNAUTHENTICATED", "message.received.unauthenticated"],
];

export function eventTypeFor(labels: string[] | undefined) {
  const upper = new Set((labels ?? []).map((label) => label.toUpperCase()));
  return LABEL_EVENTS.find(([label]) => upper.has(label))?.[1] ?? "message.received";
}

type PollTarget = { mailbox_id: string; workspace_id: string; address: string; set_up_at: Date | string };

export type PollReport = { checked: number; stored: number; started: number; failed: number };

export async function pollAgentMailboxes(options: { fetchImpl?: typeof fetch; now?: number; deadline?: number; start?: typeof startAgentMailJob } = {}): Promise<PollReport> {
  const report: PollReport = { checked: 0, stored: 0, started: 0, failed: 0 };
  if (!machineMailConfigured()) return report;
  const now = options.now ?? Date.now();
  const deadline = options.deadline ?? now + 30_000;
  const start = options.start ?? startAgentMailJob;
  const targets = (await query<PollTarget>("select * from private.agent_mailbox_poll_targets()")).rows;
  let budget = FETCHES_PER_RUN;
  for (const target of targets) {
    if (Date.now() > deadline || budget <= 0) break;
    try {
      const after = new Date(now - POLL_LOOKBACK_MS);
      const listed = (await listRecentMessages(target.address, after, options.fetchImpl)).filter(
        (message) => message.direction !== "outbound" && !(message.labels ?? []).some((label) => ["SENT", "DRAFT"].includes(label.toUpperCase())),
      );
      report.checked += listed.length;
      if (listed.length === 0) continue;
      const known = new Set(
        (await query<{ message_id: string }>("select * from private.agent_mail_known($1, $2::text[])", [target.mailbox_id, listed.map((message) => message.message_id.slice(0, 200))])).rows.map(
          (row) => row.message_id,
        ),
      );
      for (const item of listed) {
        if (known.has(item.message_id.slice(0, 200))) continue;
        if (Date.now() > deadline || budget <= 0) break;
        budget -= 1;
        const message = (await getMessage(target.address, item.message_id, options.fetchImpl)) as RawMessage;
        if (typeof message.inbox_id !== "string") message.inbox_id = target.address;
        const labels = Array.isArray(message.labels) ? (message.labels as string[]) : item.labels;
        const result = await storeAgentMessage(target, `poll:${item.message_id}`.slice(0, 200), eventTypeFor(labels), message);
        if (result.body.stored) report.stored += 1;
        if (result.job) {
          await start(result.job);
          report.started += 1;
        }
      }
    } catch (error) {
      report.failed += 1;
      if (error instanceof MachineMailError && (error.status === 401 || error.status === 403)) {
        await noteMailboxError(target.mailbox_id, `Couldn't check the inbox for missed mail: ${error.message}`);
      } else {
        console.error("Checking the agent mailbox failed", error instanceof Error ? error.name : "unknown");
      }
    }
  }
  return report;
}
