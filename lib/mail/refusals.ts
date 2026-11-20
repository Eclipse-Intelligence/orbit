import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";

export const MOVE_ACTIONS = ["archive", "trash", "inbox", "snooze"] as const;
export type MoveAction = (typeof MOVE_ACTIONS)[number];

export function isMoveAction(action: unknown): action is MoveAction {
  return MOVE_ACTIONS.some((item) => item === action);
}

export type MailRefusal = { id: string; action: MoveAction; subject: string | null; problem: string };

export async function takeMailRefusals(actor: UserActor): Promise<MailRefusal[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<MailRefusal>(
      `update crm.mail_pending_actions set shown_at = now()
       where user_id = $1 and refused_at is not null and shown_at is null
       returning id, action, subject, problem`,
      [actor.userId],
    );
    return result.rows;
  });
}
