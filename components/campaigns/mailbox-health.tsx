import Tag from "@/components/_ui/tag";
import type { MailboxHealth as Health } from "@/lib/crm/campaigns";

export default function MailboxHealth({ health }: { health: Health }) {
  if (!health) return null;
  if (health.error) {
    return (
      <p role="status" className="ui-style text-subtle">
        {health.error}
      </p>
    );
  }
  const { mailboxes } = health;
  if (mailboxes.length === 0) return <p className="ui-style text-subtle">No mailboxes</p>;
  const limits = mailboxes.map((mailbox) => mailbox.dailyLimit).filter((limit): limit is number => limit !== null);
  const daily = limits.reduce((sum, limit) => sum + limit, 0);
  const count = mailboxes.length === 1 ? "1 mailbox" : `${mailboxes.length.toLocaleString("en-GB")} mailboxes`;
  const problems = mailboxes.filter((mailbox) => mailbox.problem);
  return (
    <div className="flex flex-col gap-2">
      <p className="ui-style">{limits.length > 0 ? `${count} send ${daily.toLocaleString("en-GB")} a day.` : `${count}.`}</p>
      {problems.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {problems.map((mailbox) => (
            <li key={mailbox.address} className="ui-style flex min-w-0 flex-wrap items-center gap-2">
              <Tag tone="amber" size="sm" className="caption-style">
                Check
              </Tag>
              <span className="min-w-0 wrap-anywhere">
                {mailbox.address} · {mailbox.problem}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
