import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import { listMembers } from "@/lib/crm/companies";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { iso, isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { DEFAULT_ADDRESS, DEFAULT_SENDERS, bareAddress } from "@/lib/agent-mail/senders";
import { MachineMailError, deleteWebhook, ensureInbox, ensureWebhook, machineMailConfigured } from "@/lib/machinemail";
import { siteOrigin } from "@/lib/site-url";

export const WEBHOOK_PATH = "/api/machinemail/webhook";
export const SENDERS_MAX = 50;
const DISPLAY_NAME = "Orbit";

export type AgentSender = { address: string; userId: string; name: string };
export type AgentMailMember = { id: string; name: string };
export type AgentMailboxView = {
  configured: boolean;
  canAdmin: boolean;
  address: string;
  setUp: boolean;
  setUpAt: string | null;
  lastReceivedAt: string | null;
  lastError: string | null;
  lastMessage: { from: string | null; subject: string | null; receivedAt: string; status: string; reason: string | null } | null;
  senders: AgentSender[];
  members: AgentMailMember[];
  defaults: string[];
};

export type AgentMailboxRow = {
  id: string;
  workspace_id: string;
  address: string;
  display_name: string;
  webhook_id: string | null;
  webhook_url: string | null;
  set_up_at: Date | string | null;
  last_received_at: Date | string | null;
  last_error: string | null;
};

const MAILBOX_COLUMNS = "id, workspace_id, address, display_name, webhook_id, webhook_url, set_up_at, last_received_at, last_error";

export function isWorkspaceAdmin(actor: UserActor) {
  return actor.role === "owner" || actor.role === "admin";
}

function requireAdmin(actor: UserActor) {
  if (!isWorkspaceAdmin(actor)) throw new CrmError("forbidden", "Only owners and admins can change the agent mailbox.", 403);
}

export async function agentMailbox(actor: UserActor): Promise<AgentMailboxRow | null> {
  return withActor(actor, async (db) => {
    const result = await db.query<AgentMailboxRow>(`select ${MAILBOX_COLUMNS} from crm.agent_mailboxes where workspace_id = $1`, [actor.workspaceId]);
    return result.rows[0] ?? null;
  });
}

export function mailboxOrigin(mailbox: Pick<AgentMailboxRow, "webhook_url">) {
  const configured = siteOrigin();
  if (configured) return configured;
  try {
    return mailbox.webhook_url ? new URL(mailbox.webhook_url).origin : null;
  } catch {
    return null;
  }
}

export async function requireAgentMailAccess(actor: UserActor) {
  const mailbox = await agentMailbox(actor);
  if (!mailbox?.set_up_at) {
    throw new CrmError("not_found", "The agent mailbox isn't set up. An owner or admin can set it up in Settings › Integrations.", 404);
  }
  if (isWorkspaceAdmin(actor)) return mailbox;
  const mapped = await withActor(actor, async (db) => {
    const result = await db.query("select 1 from crm.agent_mailbox_senders where workspace_id = $1 and user_id = $2 limit 1", [actor.workspaceId, actor.userId]);
    return (result.rowCount ?? 0) > 0;
  });
  if (!mapped) throw new CrmError("forbidden", "Only owners, admins and people who can give the agent work can use the agent mailbox.", 403);
  return mailbox;
}

export async function agentMailboxView(actor: UserActor): Promise<AgentMailboxView> {
  const canAdmin = isWorkspaceAdmin(actor);
  const mailbox = await agentMailbox(actor);
  const [senders, members, last] = await Promise.all([
    withActor(actor, async (db) => {
      const result = await db.query<{ address: string; user_id: string; name: string | null }>(
        `select s.address, s.user_id, coalesce(nullif(p.full_name, ''), p.email) as name
         from crm.agent_mailbox_senders s join crm.profiles p on p.id = s.user_id
         where s.workspace_id = $1 order by s.created_at, s.address`,
        [actor.workspaceId],
      );
      return result.rows.map((row) => ({ address: row.address, userId: row.user_id, name: row.name ?? "Member" }));
    }),
    canAdmin ? listMembers(actor).then((list) => list.map((member) => ({ id: member.id, name: member.name }))) : Promise.resolve([]),
    withActor(actor, async (db) => {
      const result = await db.query<{ from_address: string | null; subject: string | null; received_at: Date; status: string; status_reason: string | null }>(
        `select from_address, subject, received_at, status, status_reason from crm.agent_mail_messages
         where workspace_id = $1 and direction = 'inbound' order by received_at desc limit 1`,
        [actor.workspaceId],
      );
      return result.rows[0] ?? null;
    }),
  ]);
  return {
    configured: machineMailConfigured(),
    canAdmin,
    address: mailbox?.address ?? DEFAULT_ADDRESS,
    setUp: Boolean(mailbox?.set_up_at),
    setUpAt: iso(mailbox?.set_up_at ?? null),
    lastReceivedAt: iso(mailbox?.last_received_at ?? null),
    lastError: canAdmin ? mailbox?.last_error ?? null : null,
    lastMessage: last
      ? { from: last.from_address, subject: last.subject, receivedAt: iso(last.received_at) ?? new Date().toISOString(), status: last.status, reason: last.status_reason }
      : null,
    senders,
    members,
    defaults: DEFAULT_SENDERS,
  };
}

function cleanMailboxAddress(value: unknown) {
  const address = bareAddress(typeof value === "string" ? value : "");
  if (!address || !/^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9.-]+\.[a-z]{2,}$/.test(address) || !/[a-z0-9]@/.test(address)) {
    throw new CrmError("invalid_input", "Enter the address as name@domain, for example orbit@ai-mail.geteclipse.co.", 400, { field: "address" });
  }
  return address;
}

function webhookOrigin() {
  const site = siteOrigin();
  if (!site || !/^https:\/\//.test(site)) {
    throw new CrmError("invalid_input", "Set SITE_URL to Orbit's https address first, so MachineMail can reach it.", 400);
  }
  return site.replace(/\/+$/, "");
}

function upstream(error: unknown): never {
  if (error instanceof MachineMailError) {
    if (error.status === 401 || error.status === 403) throw new CrmError("upstream_error", "MachineMail refused the API key. Check MACHINE_MAIL_API_KEY.", 502);
    throw new CrmError("upstream_error", `MachineMail: ${error.message}`, 502);
  }
  throw error;
}

export async function setUpAgentMailbox(actor: UserActor, input: { address?: unknown }, fetchImpl: typeof fetch = fetch) {
  requireAdmin(actor);
  if (!machineMailConfigured()) throw new CrmError("invalid_input", "Set MACHINE_MAIL_API_KEY on the server first.", 400);
  const existing = await agentMailbox(actor);
  const address = existing?.set_up_at ? existing.address : cleanMailboxAddress(input.address ?? existing?.address ?? DEFAULT_ADDRESS);
  if (existing?.set_up_at && typeof input.address === "string" && input.address.trim() && cleanMailboxAddress(input.address) !== existing.address) {
    throw new CrmError("invalid_input", "The address can't change once the mailbox is set up.", 400, { field: "address" });
  }
  const url = `${webhookOrigin()}${WEBHOOK_PATH}`;
  let webhook: { id: string; secret: string };
  try {
    await ensureInbox(address, DISPLAY_NAME, fetchImpl);
    webhook = await ensureWebhook(address, url, fetchImpl);
  } catch (error) {
    if (existing) await query("select private.agent_mailbox_note_error($1, $2)", [existing.id, error instanceof Error ? error.message : "Set up failed."]).catch(() => undefined);
    upstream(error);
  }
  if (existing?.webhook_id && existing.webhook_id !== webhook.id) await deleteWebhook(existing.webhook_id, fetchImpl).catch(() => undefined);
  await withActor(actor, async (db) => {
    await db.query(
      `insert into crm.agent_mailboxes (workspace_id, address, display_name) values ($1, $2, $3)
       on conflict (workspace_id) do nothing`,
      [actor.workspaceId, address, DISPLAY_NAME],
    );
    const updated = await db.query<{ id: string }>(
      `update crm.agent_mailboxes
       set address = $2, webhook_id = $3, webhook_secret = $4, webhook_url = $5, set_up_by = $6, set_up_at = now(), last_error = null, last_error_at = null
       where workspace_id = $1 returning id`,
      [actor.workspaceId, address, webhook.id.slice(0, 200), encryptSecret(webhook.secret), url, actor.userId],
    );
    const mailboxId = updated.rows[0].id;
    const count = await db.query<{ count: number }>("select count(*)::int as count from crm.agent_mailbox_senders where workspace_id = $1", [actor.workspaceId]);
    if ((count.rows[0]?.count ?? 0) === 0) {
      for (const sender of DEFAULT_SENDERS) {
        await db.query(
          `insert into crm.agent_mailbox_senders (workspace_id, mailbox_id, address, user_id, created_by)
           values ($1, $2, $3, $4, $4) on conflict (workspace_id, address) do nothing`,
          [actor.workspaceId, mailboxId, sender, actor.userId],
        );
      }
    }
  });
  return { message: existing?.set_up_at ? "Checked. The agent mailbox is set up." : "The agent mailbox is set up." };
}

export async function saveAgentSenders(actor: UserActor, rows: unknown) {
  requireAdmin(actor);
  const list = Array.isArray(rows) ? rows : [];
  if (list.length > SENDERS_MAX) throw new CrmError("invalid_input", `Add up to ${SENDERS_MAX} addresses.`, 400, { field: "senders" });
  const members = new Set((await listMembers(actor)).map((member) => member.id));
  const seen = new Map<string, string>();
  for (const raw of list) {
    const entry = (raw && typeof raw === "object" ? raw : {}) as { address?: unknown; userId?: unknown };
    const typed = typeof entry.address === "string" ? entry.address.trim() : "";
    if (!typed) continue;
    const address = bareAddress(typed);
    if (!address) throw new CrmError("invalid_input", `${typed.slice(0, 80)} isn't an email address.`, 400, { field: "senders" });
    const userId = typeof entry.userId === "string" && isUuid(entry.userId) && members.has(entry.userId) ? entry.userId : null;
    if (!userId) throw new CrmError("invalid_input", `Choose who owns the work from ${address}.`, 400, { field: "senders" });
    if (seen.has(address)) throw new CrmError("invalid_input", `${address} is on the list twice.`, 400, { field: "senders" });
    seen.set(address, userId);
  }
  const mailbox = await agentMailbox(actor);
  if (!mailbox?.set_up_at) throw new CrmError("invalid_input", "Set up the agent mailbox first.", 400);
  if (seen.has(mailbox.address)) throw new CrmError("invalid_input", "The agent mailbox can't give itself work.", 400, { field: "senders" });
  await withActor(actor, async (db) => {
    await db.query("delete from crm.agent_mailbox_senders where workspace_id = $1", [actor.workspaceId]);
    for (const [address, userId] of seen) {
      await db.query(
        `insert into crm.agent_mailbox_senders (workspace_id, mailbox_id, address, user_id, created_by) values ($1, $2, $3, $4, $5)`,
        [actor.workspaceId, mailbox.id, address, userId, actor.userId],
      );
    }
  });
  return { message: seen.size ? "Saved." : "Saved. Nobody can give it work by email now." };
}

export type MailboxTarget = { mailbox_id: string; workspace_id: string; address: string; secret: string };

export async function mailboxTargets(): Promise<MailboxTarget[]> {
  const result = await query<{ mailbox_id: string; workspace_id: string; address: string; webhook_secret: string }>("select * from private.agent_mailbox_targets()");
  const targets: MailboxTarget[] = [];
  for (const row of result.rows) {
    let secret = "";
    try {
      secret = decryptSecret(row.webhook_secret);
    } catch {
      await noteMailboxError(row.mailbox_id, UNREADABLE_SECRET);
      continue;
    }
    if (secret) targets.push({ mailbox_id: row.mailbox_id, workspace_id: row.workspace_id, address: row.address, secret });
  }
  return targets;
}

export const UNREADABLE_SECRET = "Orbit can't read the webhook's signing secret. Set up again.";

export async function noteMailboxError(mailboxId: string, message: string | null) {
  await query("select private.agent_mailbox_note_error($1, $2)", [mailboxId, message ?? ""]).catch(() => undefined);
}
