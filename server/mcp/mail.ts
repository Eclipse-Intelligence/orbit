import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { askMail } from "@/lib/mail/ai";
import { attachmentNotes } from "@/lib/mail/attachment-context";
import { listMailAttachments } from "@/lib/mail/attachments";
import { composeAccounts, discardMailDraft, readDraftInput, saveMailDraft } from "@/lib/mail/compose";
import { stripQuoted } from "@/lib/mail/format";
import { mailOrigin } from "@/lib/mail/origin";
import { getThread, listThreads } from "@/lib/mail/threads";
import { MAIL_SPLITS, type MailView } from "@/lib/mail/view";

type Fetcher = { fetchImpl?: typeof fetch };

const VIEWS = ["inbox", ...MAIL_SPLITS, "snoozed", "sent", "drafts", "archive", "trash"] as const;
const TEXT_MAX = 12_000;

const address = z.union([z.string(), z.object({ address: z.string(), name: z.string().optional() })]);

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolFailure(error: unknown) {
  const message = error instanceof CrmError ? `${error.code}: ${error.message}` : "The mail request failed.";
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

async function run(work: () => Promise<unknown>) {
  try {
    return toolResult(await work());
  } catch (error) {
    return toolFailure(error);
  }
}

function viewFor(value: (typeof VIEWS)[number] | undefined): MailView {
  if (!value || value === "inbox") return { role: "inbox" };
  if ((MAIL_SPLITS as readonly string[]).includes(value)) return { role: "inbox", split: value as (typeof MAIL_SPLITS)[number] };
  return { role: value as "snoozed" | "sent" | "drafts" | "archive" | "trash" };
}

async function resolveFrom(actor: UserActor, from: string | undefined) {
  if (!from) return { sourceId: null, identityId: null };
  const account = (await composeAccounts(actor)).find((item) => item.id === from || item.email.toLowerCase() === from.toLowerCase());
  if (!account) throw new CrmError("invalid_input", "Choose an account from mail_accounts.", 400, { field: "from" });
  return { sourceId: account.sourceId ?? account.id, identityId: account.identityId ?? null };
}

export function registerMailTools(server: McpServer, actor: UserActor, options: Fetcher = {}) {
  server.registerTool(
    "mail_accounts",
    { description: "List the mail accounts and sending addresses this person can use, with their ids for mail_save_draft's from.", inputSchema: {} },
    async () => run(async () => ({ accounts: (await composeAccounts(actor)).map((item) => ({ id: item.id, email: item.email })) })),
  );

  server.registerTool(
    "mail_search",
    {
      description:
        "List or search this person's email conversations, newest first. view picks a folder or an inbox split (important, other, news, calendar); query searches every folder. Returns thread keys for mail_get_thread.",
      inputSchema: {
        query: z.string().max(300).optional(),
        view: z.enum(VIEWS).optional(),
        account_id: z.uuid().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) =>
      run(async () => {
        const result = await listThreads(actor, { view: viewFor(args.view), sourceId: args.account_id ?? null, query: args.query, limit: args.limit ?? 20 });
        return {
          threads: result.threads.map((thread) => ({
            key: thread.key,
            account: thread.account,
            subject: thread.subject,
            from: thread.from,
            to: thread.to,
            snippet: thread.snippet,
            messages: thread.count,
            latestAt: thread.latestAt,
            unread: thread.unread,
            flagged: thread.flagged,
            hasAttachments: thread.hasAttachments,
            split: thread.split,
            replyReady: thread.prepared,
          })),
        };
      }),
  );

  server.registerTool(
    "mail_get_thread",
    {
      description:
        "Read one conversation by its key: every message as plain text (quoted history removed), with ids for replies and attachments, plus any saved drafts and Orbit's prepared reply.",
      inputSchema: { key: z.string().min(3).max(500) },
    },
    async (args) =>
      run(async () => {
        const detail = await getThread(actor, args.key);
        return {
          key: detail.key,
          account: detail.account,
          subject: detail.subject,
          messages: detail.messages.map((message) => ({
            id: message.id,
            folder: message.folder,
            from: message.from,
            to: message.to,
            cc: message.cc,
            at: message.at,
            isDraft: message.isDraft,
            hasAttachments: message.hasAttachments,
            text: stripQuoted(message.text ?? message.snippet ?? "").slice(0, TEXT_MAX),
          })),
          drafts: detail.drafts.map((draft) => ({ id: draft.id, mode: draft.mode, to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body, sendAt: draft.sendAt })),
          preparedReply: detail.prepared ? { kind: detail.prepared.kind, body: detail.prepared.body } : null,
          followUp: detail.followUp,
        };
      }),
  );

  server.registerTool(
    "mail_read_attachments",
    {
      description: "List an email's attachments and return the text Orbit can read from them (PDF, Word, Excel, PowerPoint, text, CSV and HTML).",
      inputSchema: { message_id: z.uuid() },
    },
    async (args) =>
      run(async () => {
        const [items, notes] = await Promise.all([
          listMailAttachments(actor, args.message_id, options.fetchImpl),
          attachmentNotes(actor, [args.message_id], { budget: 40_000, deadline: Date.now() + 40_000, fetchImpl: options.fetchImpl }),
        ]);
        return { attachments: items.map((item) => ({ name: item.name, contentType: item.contentType, size: item.size })), text: notes };
      }),
  );

  server.registerTool(
    "mail_ask",
    {
      description: "Ask a question about this person's email and attachments. Orbit searches, reads the matches and answers with its sources.",
      inputSchema: { question: z.string().min(3).max(500), account_id: z.uuid().optional() },
    },
    async (args) => run(() => askMail(actor, { question: args.question, account: args.account_id ?? null }, options)),
  );

  server.registerTool(
    "mail_save_draft",
    {
      description:
        "Save an email as a draft in Outlook and Orbit for the person to review and send. This never sends anything. mode is new, reply, reply_all or forward; replies and forwards need message_id (from mail_get_thread). body is plain text; Orbit adds the signature. Pass draft_id to update a draft you saved earlier.",
      inputSchema: {
        mode: z.enum(["new", "reply", "reply_all", "forward"]),
        message_id: z.uuid().optional(),
        draft_id: z.uuid().optional(),
        from: z.string().max(320).optional().describe("An id or address from mail_accounts. Defaults to the account the conversation is in."),
        to: z.array(address).max(50).optional(),
        cc: z.array(address).max(50).optional(),
        bcc: z.array(address).max(50).optional(),
        subject: z.string().max(300).optional(),
        body: z.string().max(20_000),
      },
    },
    async (args) =>
      run(async () => {
        const from = await resolveFrom(actor, args.from);
        const sourceId = from.sourceId ?? (args.mode === "new" ? (await composeAccounts(actor)).find((item) => !item.identityId)?.id ?? null : null);
        const draft = await saveMailDraft(
          actor,
          readDraftInput({
            id: args.draft_id,
            mode: args.mode,
            messageId: args.message_id,
            sourceId,
            identityId: from.identityId,
            to: args.to ?? [],
            cc: args.cc ?? [],
            bcc: args.bcc ?? [],
            subject: args.subject ?? "",
            body: args.body,
          }),
          { origin: mailOrigin(), fetchImpl: options.fetchImpl },
        );
        return { draft: { id: draft.id, mode: draft.mode, to: draft.to, cc: draft.cc, subject: draft.subject, savedAt: draft.savedAt }, sent: false };
      }),
  );

  server.registerTool(
    "mail_discard_draft",
    {
      description: "Delete a draft saved with mail_save_draft, from Orbit and Outlook.",
      inputSchema: { draft_id: z.uuid() },
    },
    async (args) =>
      run(async () => {
        await discardMailDraft(actor, args.draft_id, options.fetchImpl);
        return { discarded: true };
      }),
  );
}
