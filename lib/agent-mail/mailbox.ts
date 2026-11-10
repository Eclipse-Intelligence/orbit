import { heldAgentMail, type HeldAgentMail } from "@/lib/agent-mail/held";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import { listMembers } from "@/lib/crm/companies";
import { withActor } from "@/lib/crm/context";
import { CrmError, isPgError, notSetUp } from "@/lib/crm/errors";
import { iso, isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { DEFAULT_ADDRESS, bareAddress } from "@/lib/agent-mail/senders";
import { myAddresses } from "@/lib/crm/calendar";
import { MachineMailError, deleteWebhook, ensureInbox, ensureWebhook, machineMailConfigured } from "@/lib/machinemail";
import { siteOrigin } from "@/lib/site-url";

export const WEBHOOK_PATH = "/api/machinemail/webhook";
export const SENDERS_MAX = 50;
const DISPLAY_NAME = "Orbit";

export type AgentSender = { address: string; userId: string; name: string; problem: string | null };
export type AgentMailMember = { id: string; name: string };
export type AgentMailboxView = {
  configured: boolean;
  canAdmin: boolean;
  workspaceId: string;
  workspaceName: string;
  address: string;
  placeholder: string;
  setUp: boolean;
  setUpAt: string | null;
  lastReceivedAt: string | null;
  lastError: string | null;
  lastMessage: { from: string | null; subject: string | null; receivedAt: string; status: string; reason: string | null } | null;
  held: HeldAgentMail[];
  senders: AgentSender[];
  members: AgentMailMember[];
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

export async function agentMailboxFor(actor: UserActor, mailboxId: string): Promise<AgentMailboxRow | null> {
  return withActor(actor, async (db) => {
    const result = await db.query<AgentMailboxRow>(`select ${MAILBOX_COLUMNS} from crm.agent_mailboxes where id = $1 and workspace_id = $2`, [mailboxId, actor.workspaceId]);
    return result.rows[0] ?? null;
  });
}

export function otherWorkspacePlaceholder(workspace: { slug: string | null; name: string }) {
  const domain = DEFAULT_ADDRESS.split("@")[1];
  const generated = !workspace.slug || /^ws-[0-9a-f]{16}$/.test(workspace.slug);
  const named = workspace.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const local = generated ? named || workspace.slug : workspace.slug;
  return `${local || "workspace"}@${domain}`;
}

export function addressTakenMessage(address: string) {
  return `${address} is another workspace's agent mailbox. Choose another address.`;
}

export async function addressTaken(address: string, workspaceId: string) {
  const result = await query<{ taken: boolean }>("select private.agent_mailbox_address_taken($1, $2) as taken", [address, workspaceId]);
  return result.rows[0]?.taken === true;
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
    throw new CrmError("not_found", "The agent mailbox isn't set up. An owner or admin can set it up in Settings › Tools.", 404);
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
  const [senders, members, last, held, defaultTaken] = await Promise.all([
    withActor(actor, async (db) => {
      const result = await db.query<{ address: string; user_id: string; name: string | null }>(
        `select s.address, s.user_id, coalesce(nullif(p.full_name, ''), p.email) as name
         from crm.agent_mailbox_senders s join crm.profiles p on p.id = s.user_id
         where s.workspace_id = $1 order by s.created_at, s.address`,
        [actor.workspaceId],
      );
      return result.rows.map((row) => ({ address: row.address, userId: row.user_id, name: row.name ?? "Member" }));
    }).then(async (listed): Promise<AgentSender[]> => {
      const refusals = canAdmin ? await senderRefusals(listed.map((sender) => ({ ...sender, saved: true }))) : [];
      return listed.map((sender) => ({
        ...sender,
        problem: refusals.find((item) => item.address === sender.address && item.userId === sender.userId)?.refusal ?? null,
      }));
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
    mailbox?.set_up_at ? heldAgentMail(actor) : Promise.resolve([]),
    mailbox ? Promise.resolve(false) : addressTaken(DEFAULT_ADDRESS, actor.workspaceId).catch(() => false),
  ]);
  const placeholder = defaultTaken
    ? otherWorkspacePlaceholder({
        slug: await withActor(actor, async (db) => {
          const result = await db.query<{ slug: string }>("select slug from crm.workspaces where id = $1", [actor.workspaceId]);
          return result.rows[0]?.slug ?? null;
        }),
        name: actor.workspaceName,
      })
    : DEFAULT_ADDRESS;
  return {
    configured: machineMailConfigured(),
    canAdmin,
    workspaceId: actor.workspaceId,
    workspaceName: actor.workspaceName,
    address: mailbox?.address ?? (defaultTaken ? "" : DEFAULT_ADDRESS),
    placeholder,
    setUp: Boolean(mailbox?.set_up_at),
    setUpAt: iso(mailbox?.set_up_at ?? null),
    lastReceivedAt: iso(mailbox?.last_received_at ?? null),
    lastError: canAdmin ? mailbox?.last_error ?? null : null,
    lastMessage: last
      ? { from: last.from_address, subject: last.subject, receivedAt: iso(last.received_at) ?? new Date().toISOString(), status: last.status, reason: last.status_reason }
      : null,
    held,
    senders,
    members,
  };
}

function cleanMailboxAddress(value: unknown) {
  const address = bareAddress(typeof value === "string" ? value : "");
  if (!address || !/^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9.-]+\.[a-z]{2,}$/.test(address) || !/[a-z0-9]@/.test(address)) {
    throw new CrmError("invalid_input", "Enter the address as name@domain, for example orbit@ai-mail.geteclipse.co.", 400, { field: "address" });
  }
  return address;
}

function webhookOrigin(actor: UserActor) {
  const site = siteOrigin();
  if (!site || !/^https:\/\//.test(site)) {
    throw new CrmError("invalid_input", actor.role === "owner" ? "Set SITE_URL to Orbit's https address first, so MachineMail can reach it." : notSetUp("Orbit's web address"), 400);
  }
  return site.replace(/\/+$/, "");
}

function upstream(error: unknown, actor: UserActor): never {
  if (error instanceof MachineMailError) {
    if (error.status === 401 || error.status === 403) throw new CrmError("upstream_error", `MachineMail rejected the key.${actor.role === "owner" ? " Check MACHINE_MAIL_API_KEY." : ""}`, 502);
    throw new CrmError("upstream_error", error.message, 502);
  }
  throw error;
}

export async function setUpAgentMailbox(actor: UserActor, input: { address?: unknown }, fetchImpl: typeof fetch = fetch) {
  requireAdmin(actor);
  if (!machineMailConfigured()) throw new CrmError("invalid_input", notSetUp("MachineMail", "MACHINE_MAIL_API_KEY", actor), 400);
  const existing = await agentMailbox(actor);
  const address = existing?.set_up_at ? existing.address : cleanMailboxAddress(input.address ?? existing?.address ?? DEFAULT_ADDRESS);
  if (existing?.set_up_at && typeof input.address === "string" && input.address.trim() && cleanMailboxAddress(input.address) !== existing.address) {
    throw new CrmError("invalid_input", "The address can't change once the mailbox is set up.", 400, { field: "address" });
  }
  if (!existing?.set_up_at && (await addressTaken(address, actor.workspaceId))) {
    throw new CrmError("conflict", addressTakenMessage(address), 409, { field: "address" });
  }
  const url = `${webhookOrigin(actor)}${WEBHOOK_PATH}`;
  let webhook: { id: string; secret: string };
  try {
    await ensureInbox(address, DISPLAY_NAME, fetchImpl);
    webhook = await ensureWebhook(address, url, fetchImpl);
  } catch (error) {
    if (existing) await query("select private.agent_mailbox_note_error($1, $2)", [existing.id, error instanceof Error ? error.message : "Set up failed."]).catch(() => undefined);
    upstream(error, actor);
  }
  if (existing?.webhook_id && existing.webhook_id !== webhook.id) await deleteWebhook(existing.webhook_id, fetchImpl).catch(() => undefined);
  const own = existing?.set_up_at ? [] : await ownSenderAddresses(actor, address);
  await saveMailbox(actor, address, webhook, url, own).catch((error) => {
    if (isPgError(error) && error.code === "23505") throw new CrmError("conflict", addressTakenMessage(address), 409, { field: "address" });
    throw error;
  });
  return { message: "Agent mailbox set up." };
}

export async function ownSenderAddresses(actor: UserActor, mailboxAddress: string) {
  const found = await withActor(actor, async (db) => {
    const own = await myAddresses(db, actor);
    const more = await db.query<{ email: string }>(
      "select email from crm.send_identities where user_id = $1 union select email from crm.mail_sources where user_id = $1",
      [actor.userId],
    );
    return [...own, ...more.rows.map((row) => row.email)];
  });
  const addresses = [...new Set(found.map((value) => bareAddress(value)).filter((value): value is string => Boolean(value) && value !== mailboxAddress))];
  const unknown = new Set((await senderRefusals(addresses.map((address) => ({ address, userId: actor.userId, saved: false })))).map((row) => row.address));
  const allowed: string[] = [];
  for (const candidate of addresses.filter((address) => !unknown.has(address)).slice(0, SENDERS_MAX)) {
    if (!(await addressTaken(candidate, actor.workspaceId))) allowed.push(candidate);
  }
  return allowed;
}

async function senderRefusals(pairs: { address: string; userId: string; saved: boolean }[]) {
  if (pairs.length === 0) return [];
  const result = await query<{ address: string; user_id: string; refusal: string }>(
    `select x.address, x.user_id, r.refusal
     from unnest($1::text[], $2::uuid[], $3::boolean[]) with ordinality as x(address, user_id, saved, position)
     cross join lateral (select private.agent_sender_refusal(x.user_id, x.address, x.saved) as refusal) r
     where r.refusal is not null
     order by x.position`,
    [pairs.map((pair) => pair.address), pairs.map((pair) => pair.userId), pairs.map((pair) => pair.saved)],
  );
  return result.rows.map((row) => ({ address: row.address, userId: row.user_id, refusal: row.refusal }));
}

function ownershipError(error: unknown): never {
  if (isPgError(error) && error.code === "23514" && error.constraint === "agent_mailbox_senders_owned") {
    throw new CrmError("invalid_input", error.message, 400, { field: "senders" });
  }
  throw error;
}

async function saveMailbox(actor: UserActor, address: string, webhook: { id: string; secret: string }, url: string, own: string[]) {
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
      for (const sender of own) {
        await db.query(
          `insert into crm.agent_mailbox_senders (workspace_id, mailbox_id, address, user_id, created_by)
           values ($1, $2, $3, $4, $4) on conflict (workspace_id, address) do nothing`,
          [actor.workspaceId, mailboxId, sender, actor.userId],
        );
      }
    }
  });
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
  for (const address of seen.keys()) {
    if (await addressTaken(address, actor.workspaceId)) {
      throw new CrmError("invalid_input", `${address} is another workspace's agent mailbox, so it can't give this one work.`, 400, { field: "senders" });
    }
  }
  const saved = await withActor(actor, async (db) => {
    const result = await db.query<{ address: string; user_id: string }>("select address, user_id from crm.agent_mailbox_senders where workspace_id = $1", [actor.workspaceId]);
    return new Set(result.rows.map((row) => `${row.address} ${row.user_id}`));
  });
  const [refused] = await senderRefusals([...seen].map(([address, userId]) => ({ address, userId, saved: saved.has(`${address} ${userId}`) })));
  if (refused) throw new CrmError("invalid_input", refused.refusal, 400, { field: "senders" });
  await withActor(actor, async (db) => {
    await db.query("delete from crm.agent_mailbox_senders where workspace_id = $1", [actor.workspaceId]);
    for (const [address, userId] of seen) {
      await db.query(
        `insert into crm.agent_mailbox_senders (workspace_id, mailbox_id, address, user_id, created_by) values ($1, $2, $3, $4, $5)`,
        [actor.workspaceId, mailbox.id, address, userId, actor.userId],
      );
    }
  }).catch(ownershipError);
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
