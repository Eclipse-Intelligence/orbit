import type { ThreadDetail, ThreadSummary } from "@/lib/mail/view";

export function summaryFromDetail(detail: ThreadDetail): ThreadSummary {
  const sent = detail.messages.filter((message) => !(message.isDraft && message.folderRole === "drafts"));
  const latest = sent.at(-1) ?? detail.messages.at(-1) ?? null;
  return {
    key: detail.key,
    sourceId: detail.key.split("|")[0] ?? "",
    account: detail.account,
    latestId: latest?.id ?? "",
    subject: detail.subject,
    snippet: latest?.snippet ?? null,
    from: latest?.from ?? null,
    to: latest?.to ?? [],
    count: sent.length,
    unread: sent.some((message) => !message.isRead),
    flagged: detail.messages.some((message) => message.isFlagged),
    hasAttachments: detail.messages.some((message) => message.hasAttachments),
    draft: detail.drafts.length > 0 || detail.messages.some((message) => message.isDraft && message.folderRole === "drafts"),
    latestAt: latest?.at ?? null,
    reads: null,
    reminder: null,
    snoozedUntil: null,
    split: null,
    prepared: Boolean(detail.prepared),
    followUpAt: detail.followUp?.at ?? null,
  };
}

export function bareSummary(key: string): ThreadSummary {
  return {
    key,
    sourceId: key.split("|")[0] ?? "",
    account: "",
    latestId: "",
    subject: null,
    snippet: null,
    from: null,
    to: [],
    count: 1,
    unread: false,
    flagged: false,
    hasAttachments: false,
    draft: false,
    latestAt: null,
    reads: null,
    reminder: null,
    snoozedUntil: null,
    split: null,
    prepared: false,
    followUpAt: null,
  };
}
