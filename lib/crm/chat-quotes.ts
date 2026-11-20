import { CHAT_QUOTES_MAX, type ChatKind, type ChatQuote, type ChatQuotes } from "@/lib/chat/types";
import { discussionHref } from "@/lib/chat/discussions";
import { cleanFormat } from "@/lib/chat/markdown";
import { messageHref } from "@/lib/chat/routes";
import { savedPlace } from "@/lib/chat/saved";
import { searchExcerpt } from "@/lib/chat/search";
import { directName, FORMER, GROUP_PEOPLE, iso, MEMBER_NAME, type PeopleRow } from "@/lib/crm/chat";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";

type QuoteRow = {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  author_user_id: string | null;
  author_name: string;
  body: string;
  format: string | null;
  created_at: Date | string;
  attachment_count: number;
  conversation_kind: ChatKind;
  c_name: string | null;
  task_id: string | null;
  page_id: string | null;
  mail_share_id: string | null;
  task_title: string | null;
  page_title: string | null;
  dm_name: string | null;
  c_people: PeopleRow[] | null;
};

export function cleanQuoteIds(values: unknown): string[] {
  const list = Array.isArray(values) ? values : [];
  const ids = [...new Set(list.map((value) => (typeof value === "string" && isUuid(value) ? value.toLowerCase() : null)))];
  if (ids.includes(null)) throw new CrmError("invalid_input", "One of those message ids isn't valid.", 400, { field: "id" });
  if (ids.length > CHAT_QUOTES_MAX) throw new CrmError("invalid_input", `Ask for up to ${CHAT_QUOTES_MAX} messages at a time.`, 400, { field: "id" });
  return ids as string[];
}

function placeName(row: QuoteRow) {
  if (row.conversation_kind === "task") return row.task_title ?? "";
  if (row.conversation_kind === "doc") return row.page_title ?? "";
  return directName(row.conversation_kind, { name: row.c_name, dmName: row.dm_name, people: row.c_people });
}

function quoteHref(row: QuoteRow) {
  if (row.conversation_kind === "task" && row.task_id) return discussionHref({ kind: "task", id: row.task_id });
  if (row.conversation_kind === "doc" && row.page_id) return discussionHref({ kind: "doc", id: row.page_id });
  if (row.conversation_kind === "mail_thread" && row.mail_share_id) return discussionHref({ kind: "mail_thread", id: row.mail_share_id });
  return messageHref(row.conversation_id, { id: row.id, parentId: row.parent_id });
}

export async function getMessages(actor: UserActor, ids: unknown): Promise<ChatQuotes> {
  const wanted = cleanQuoteIds(ids);
  if (wanted.length === 0) return { quotes: [] };
  return withActor(actor, async (db) => {
    const result = await db.query<QuoteRow>(
      `select m.id, m.conversation_id, m.parent_id, m.author_user_id, m.author_name, m.body, m.format, m.created_at, m.attachment_count,
         c.kind as conversation_kind, c.name as c_name, c.task_id, c.page_id, c.mail_share_id, t.title as task_title, d.title as page_title,
         case when c.kind = 'dm' then (
           select ${MEMBER_NAME("o", "op")} from crm.chat_members o left join crm.profiles op on op.id = o.user_id
           where o.conversation_id = c.id and o.user_id <> $2 limit 1
         ) end as dm_name,
         ${GROUP_PEOPLE("c", "$2::uuid")} as c_people
       from crm.chat_messages m
       join crm.chat_conversations c on c.id = m.conversation_id
       left join crm.tasks t on c.kind = 'task' and t.id = c.task_id
       left join crm.pages d on c.kind = 'doc' and d.id = c.page_id
       where m.id = any($1::uuid[]) and m.kind = 'message' and m.deleted_at is null`,
      [wanted, actor.userId],
    );
    const quotes = result.rows.map<ChatQuote>((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      author: { id: row.author_user_id, name: row.author_name || FORMER },
      excerpt: searchExcerpt(row.body, cleanFormat(row.format), ""),
      files: row.attachment_count,
      createdAt: iso(row.created_at),
      place: savedPlace({ id: row.conversation_id, kind: row.conversation_kind, name: placeName(row) }),
      href: quoteHref(row),
    }));
    return { quotes };
  });
}
