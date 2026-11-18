import Tag from "@/components/_ui/tag";
import { emailCapacityLine, emailFit, overflowLine } from "@/lib/campaigns/format";
import type { MailboxHealth as Health } from "@/lib/crm/campaigns";

export default function MailboxHealth({ health, steps, addedToday }: { health: Health; steps: number; addedToday: number }) {
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
  const daily = limits.length > 0 ? limits.reduce((sum, limit) => sum + limit, 0) : null;
  const overflow = overflowLine(addedToday, daily === null || steps < 1 ? null : emailFit(daily, steps));
  const problems = mailboxes.filter((mailbox) => mailbox.problem);
  return (
    <div className="flex flex-col gap-2">
      <p className="ui-style">{emailCapacityLine(mailboxes.length, daily, steps)}</p>
      {overflow && <p className="ui-style text-soft">{overflow}</p>}
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
