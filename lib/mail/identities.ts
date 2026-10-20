import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import type { MailAddress } from "@/lib/mail/types";

const NEO = { smtpHost: "smtp0001.neo.space", smtpPort: 465, imapHost: "imap0001.neo.space", imapPort: 993 };

export type SendIdentity = {
  id: string;
  sourceId: string;
  email: string;
  displayName: string | null;
  smtpHost: string;
  smtpPort: number;
  username: string;
  imapHost: string | null;
  imapPort: number | null;
  lastError: string | null;
  verifiedAt: string | null;
};

type IdentityRow = {
  id: string;
  source_id: string;
  email: string;
  display_name: string | null;
  smtp_host: string;
  smtp_port: number;
  username: string;
  password_cipher: string;
  imap_host: string | null;
  imap_port: number | null;
  last_error: string | null;
  verified_at: Date | string | null;
};

export type SmtpSender = (identity: SendIdentity & { password: string }, message: { from: string; to: string[]; raw: string }) => Promise<void>;
export type SentSaver = (identity: SendIdentity & { password: string }, raw: string) => Promise<void>;

const COLUMNS = "id, source_id, email, display_name, smtp_host, smtp_port, username, password_cipher, imap_host, imap_port, last_error, verified_at";

function toIdentity(row: IdentityRow): SendIdentity {
  return {
    id: row.id,
    sourceId: row.source_id,
    email: row.email,
    displayName: row.display_name,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    username: row.username,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    lastError: row.last_error,
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
  };
}

function host(value: unknown, label: string) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(text) || text.length > 255) throw new CrmError("invalid_input", `Enter the ${label} server name, for example smtp.example.com.`, 400);
  return text;
}

function port(value: unknown, fallback: number) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 65535 ? number : fallback;
}

export const defaultSmtpSender: SmtpSender = async (identity, message) => {
  const transport = nodemailer.createTransport({
    host: identity.smtpHost,
    port: identity.smtpPort,
    secure: identity.smtpPort === 465,
    requireTLS: identity.smtpPort !== 465,
    auth: { user: identity.username, pass: identity.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.sendMail({ envelope: { from: message.from, to: message.to }, raw: message.raw });
  } finally {
    transport.close();
  }
};

export const defaultSentSaver: SentSaver = async (identity, raw) => {
  if (!identity.imapHost) return;
  const client = new ImapFlow({
    host: identity.imapHost,
    port: identity.imapPort ?? 993,
    secure: (identity.imapPort ?? 993) === 993,
    auth: { user: identity.username, pass: identity.password },
    logger: false,
  });
  await client.connect();
  try {
    const boxes = await client.list();
    const sent = boxes.find((box) => box.specialUse === "\\Sent") ?? boxes.find((box) => /^(sent|sent items|sent mail)$/i.test(box.name));
    if (sent) await client.append(sent.path, raw, ["\\Seen"]);
  } finally {
    await client.logout().catch(() => undefined);
  }
};

async function verify(identity: SendIdentity & { password: string }) {
  const transport = nodemailer.createTransport({
    host: identity.smtpHost,
    port: identity.smtpPort,
    secure: identity.smtpPort === 465,
    requireTLS: identity.smtpPort !== 465,
    auth: { user: identity.username, pass: identity.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

export async function listIdentities(actor: UserActor): Promise<SendIdentity[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<IdentityRow>(`select ${COLUMNS} from crm.send_identities where user_id = $1 and workspace_id = $2 order by created_at`, [
      actor.userId,
      actor.workspaceId,
    ]);
    return result.rows.map(toIdentity);
  });
}

export async function saveIdentity(
  actor: UserActor,
  input: Record<string, unknown>,
  options: { check?: (identity: SendIdentity & { password: string }) => Promise<void> } = {},
): Promise<SendIdentity> {
  const email = canonicalEmail(typeof input.email === "string" ? input.email : "");
  if (!email) throw new CrmError("invalid_input", "Enter the email address you want to send from.", 400, { field: "email" });
  const sourceId = typeof input.sourceId === "string" && isUuid(input.sourceId) ? input.sourceId : null;
  if (!sourceId) throw new CrmError("invalid_input", "Choose the mailbox that receives this address's mail.", 400, { field: "sourceId" });
  const neo = input.provider === "neo";
  const smtpHost = neo ? NEO.smtpHost : host(input.smtpHost, "outgoing (SMTP)");
  const smtpPort = neo ? NEO.smtpPort : port(input.smtpPort, 465);
  const imapHost = neo ? NEO.imapHost : input.imapHost ? host(input.imapHost, "incoming (IMAP)") : null;
  const imapPort = neo ? NEO.imapPort : imapHost ? port(input.imapPort, 993) : null;
  const username = typeof input.username === "string" && input.username.trim() ? input.username.trim().slice(0, 320) : email;
  const displayName = typeof input.displayName === "string" && input.displayName.trim() ? input.displayName.trim().slice(0, 200) : actor.fullName;
  const existing = await withActor(actor, async (db) => {
    const source = await db.query("select 1 from crm.mail_sources where id = $1 and user_id = $2", [sourceId, actor.userId]);
    if (!source.rows.length) throw new CrmError("not_found", "That mailbox isn't connected.", 404, { field: "sourceId" });
    const found = await db.query<IdentityRow>(`select ${COLUMNS} from crm.send_identities where user_id = $1 and email = $2`, [actor.userId, email]);
    return found.rows[0] ?? null;
  });
  const password = typeof input.password === "string" && input.password ? input.password : existing ? decryptSecret(existing.password_cipher) : "";
  if (!password) throw new CrmError("invalid_input", "Enter the password for this email account.", 400, { field: "password" });
  const candidate = {
    id: existing?.id ?? randomUUID(),
    sourceId,
    email,
    displayName,
    smtpHost,
    smtpPort,
    username,
    imapHost,
    imapPort,
    lastError: null,
    verifiedAt: null,
    password,
  };
  try {
    await (options.check ?? verify)(candidate);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CrmError(
      "invalid_input",
      /auth|login|credentials|535|password/i.test(reason)
        ? "The email server didn't accept that address and password. Check them, or use an app password if your provider has one."
        : `Couldn't reach ${smtpHost}: ${reason.slice(0, 160)}`,
      400,
    );
  }
  return withActor(actor, async (db) => {
    const result = await db.query<IdentityRow>(
      `insert into crm.send_identities (id, workspace_id, user_id, source_id, email, display_name, smtp_host, smtp_port, username, password_cipher, imap_host, imap_port, verified_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       on conflict (user_id, email) do update set source_id = excluded.source_id, display_name = excluded.display_name, smtp_host = excluded.smtp_host,
         smtp_port = excluded.smtp_port, username = excluded.username, password_cipher = excluded.password_cipher, imap_host = excluded.imap_host,
         imap_port = excluded.imap_port, verified_at = now(), last_error = null
       returning ${COLUMNS}`,
      [candidate.id, actor.workspaceId, actor.userId, sourceId, email, displayName, smtpHost, smtpPort, username, encryptSecret(password), imapHost, imapPort],
    );
    return toIdentity(result.rows[0]);
  });
}

export async function removeIdentity(actor: UserActor, id: string) {
  if (!isUuid(id)) return;
  await withActor(actor, (db) => db.query("delete from crm.send_identities where id = $1 and user_id = $2", [id, actor.userId]));
}

export async function identityForSend(actor: UserActor, id: string) {
  const row = await withActor(actor, async (db) => {
    const result = await db.query<IdentityRow>(`select ${COLUMNS} from crm.send_identities where id = $1 and user_id = $2`, [id, actor.userId]);
    return result.rows[0] ?? null;
  });
  if (!row) throw new CrmError("not_found", "That sending address isn't set up any more. Choose another From address.", 404);
  return { ...toIdentity(row), password: decryptSecret(row.password_cipher) };
}

export async function noteIdentityError(actor: UserActor, id: string, message: string | null) {
  await withActor(actor, (db) => db.query("update crm.send_identities set last_error = $2 where id = $1", [id, message?.slice(0, 500) ?? null]));
}

function encodeName(name: string) {
  return /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?=`;
}

export function rewriteMime(mime: string, from: MailAddress, now = new Date()) {
  const split = mime.search(/\r?\n\r?\n/);
  const headerText = split === -1 ? mime : mime.slice(0, split);
  const body = split === -1 ? "" : mime.slice(split);
  const newline = headerText.includes("\r\n") ? "\r\n" : "\n";
  const lines = headerText.split(/\r?\n/);
  const headers: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1] += `${newline}${line}`;
    else headers.push(line);
  }
  const drop = /^(from|sender|return-path|bcc|date|x-ms-[^:]*|x-ms-exchange-[^:]*):/i;
  const kept = headers.filter((header) => !drop.test(header));
  const fromHeader = `From: ${from.name ? `${encodeName(from.name)} ` : ""}<${from.address}>`;
  const extra = [fromHeader, `Date: ${now.toUTCString().replace("GMT", "+0000")}`];
  if (!kept.some((header) => /^message-id:/i.test(header))) extra.push(`Message-ID: <${randomUUID()}@${from.address.split("@")[1]}>`);
  return `${[...extra, ...kept].join(newline)}${body}`;
}
