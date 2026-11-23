import type { UserActor } from "@/lib/crm/types";

export const SYNC_SHARE = 0.6;
const MIN_TURN_MS = 5_000;

export type MailPassSteps<Report> = {
  sync: (actor: UserActor, deadline: number) => Promise<Report>;
  extras: (actor: UserActor, deadline: number) => Promise<void>;
};

export async function runMailPass<Report>(
  actors: UserActor[],
  steps: MailPassSteps<Report>,
  mailDeadline: number,
): Promise<{ userId: string; report: Report | { error: string } }[]> {
  const users: { userId: string; report: Report | { error: string } }[] = [];
  const synced: UserActor[] = [];
  const syncDeadline = Date.now() + Math.floor((mailDeadline - Date.now()) * SYNC_SHARE);
  for (const [index, actor] of actors.entries()) {
    const remaining = syncDeadline - Date.now();
    if (remaining < MIN_TURN_MS) break;
    try {
      const report = await steps.sync(actor, Date.now() + Math.floor(remaining / (actors.length - index)));
      users.push({ userId: actor.userId, report });
      synced.push(actor);
    } catch (error) {
      users.push({ userId: actor.userId, report: { error: error instanceof Error ? error.message : "Mail sync failed." } });
    }
  }
  for (const [index, actor] of synced.entries()) {
    const remaining = mailDeadline - Date.now();
    if (remaining < MIN_TURN_MS) break;
    await steps.extras(actor, Date.now() + Math.floor(remaining / (synced.length - index)));
  }
  return users;
}
