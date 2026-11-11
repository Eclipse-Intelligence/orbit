import { landsInSubjectWorkspace, TEAM_ALERT_SOURCES, type AlertSource, type TeamAlertSource } from "@/lib/alert-sources";
import { afterCommit } from "@/lib/crm/after-commit";
import { withActor } from "@/lib/crm/context";
import { memberActor } from "@/lib/crm/conversations";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { Actor, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { alertLink } from "@/lib/crm/workspaces";
import { query, type Db } from "@/lib/db/pool";
import { publishLiveBatch } from "@/lib/docs/live/broadcast";
import { personTopic, type AlertMessage } from "@/lib/docs/live/protocol";
import { appBadge, teamNotifyOn } from "@/lib/mail/notify";
import { pushToUser, type PushSender } from "@/lib/push";
import { notify, type NotificationCategory } from "@/lib/workflows/engine";

type Alert = {
  key?: string;
  title: string;
  body: string;
  url: string;
  tag?: string;
  source?: AlertSource;
  bell?: { title: string; body?: string | null; href?: string | null; category?: NotificationCategory };
};

export async function sendAlert(actor: UserActor, alert: Alert, options: { send?: PushSender } = {}) {
  if (alert.key) {
    const fresh = await withActor(actor, async (db) => {
      const result = await db.query(
        `insert into crm.push_log (workspace_id, user_id, key) values ($1, $2, $3)
         on conflict (user_id, key) do nothing returning id`,
        [actor.workspaceId, actor.userId, alert.key!.slice(0, 500)],
      );
      return (result.rowCount ?? 0) > 0;
    });
    if (!fresh) return { sent: 0, skipped: true };
  }
  if (alert.bell) {
    await notify(actor, actor.userId, {
      title: alert.bell.title,
      body: alert.bell.body ?? null,
      href: alert.bell.href ?? null,
      source: alert.source ?? "mail",
      category: alert.bell.category,
    }).catch(() => undefined);
  }
  const result = await pushToUser(actor, { title: alert.title, body: alert.body, url: alert.url, tag: alert.tag }, options);
  return { sent: result.sent, skipped: false };
}

export type TeamAlert = {
  source: TeamAlertSource;
  key: string;
  title: string;
  body?: string | null;
  href: string;
  tag: string;
  workspaceId?: string | null;
};

export type TeamAlertOptions = { send?: PushSender; budgetMs?: number; recipientsVerified?: boolean; includeSelf?: boolean };

type Membership = {
  user_id: string;
  workspace_id: string;
  workspace_name: string;
  role: WorkspaceRole;
  email: string | null;
  full_name: string | null;
};

const ALERT_BUDGET_MS = 8_000;
const ALERT_CONCURRENCY = 6;
const HREF_MAX = 300;
const NOTIFICATION_HREF_MAX = 500;
const UNSAFE_LINK = /[\\\u0000-\u001f\u007f]/;

function cut(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value;
}

async function memberships(userIds: string[]) {
  const result = await query<Membership>(
    `select r.user_id, m.workspace_id, m.workspace_name, m.role, m.email, m.full_name
     from unnest($1::uuid[]) with ordinality as r(user_id, n)
     cross join lateral private.memberships_for(r.user_id) with ordinality as m(workspace_id, workspace_name, workspace_slug, role, email, full_name, position)
     order by r.n, m.position`,
    [userIds],
  );
  const byUser = new Map<string, Membership[]>();
  for (const row of result.rows) byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row]);
  return byUser;
}

export async function alertTargets(
  actor: Actor,
  recipients: string[],
  alert: Pick<TeamAlert, "source" | "workspaceId">,
  options: Pick<TeamAlertOptions, "recipientsVerified" | "includeSelf"> = {},
): Promise<UserActor[]> {
  const self = actor.type === "user" ? actor.userId : null;
  const wanted = [...new Set(recipients.filter((id) => typeof id === "string" && isUuid(id)).map((id) => id.toLowerCase()))].filter((id) => options.includeSelf || id !== self);
  if (wanted.length === 0) return [];
  const subject = landsInSubjectWorkspace(alert.source) ? alert.workspaceId ?? null : null;
  if (landsInSubjectWorkspace(alert.source) && !subject) return [];
  const byUser = await memberships(self ? [self, ...wanted] : wanted);
  const shared = self ? new Set((byUser.get(self) ?? []).map((row) => row.workspace_id)) : new Set([actor.workspaceId]);
  if (subject && !shared.has(subject)) return [];
  const targets: UserActor[] = [];
  for (const userId of wanted) {
    const rows = byUser.get(userId) ?? [];
    if (!options.recipientsVerified && !rows.some((row) => shared.has(row.workspace_id))) continue;
    const landing = subject ? rows.find((row) => row.workspace_id === subject) : rows[0];
    if (landing) targets.push(memberActor(landing));
  }
  return targets;
}

function checkAlert(alert: TeamAlert) {
  if (!TEAM_ALERT_SOURCES.includes(alert.source)) throw new CrmError("invalid_input", "Pick a known alert source.", 400);
  if (!alert.title?.trim()) throw new CrmError("invalid_input", "Give the alert a title.", 400);
  if (!alert.key?.trim() || !alert.tag?.trim()) throw new CrmError("invalid_input", "Give the alert a key and a tag.", 400);
  if (!alert.href?.startsWith("/") || alert.href.startsWith("//") || UNSAFE_LINK.test(alert.href) || alert.href.length > HREF_MAX) {
    throw new CrmError("invalid_input", `Give the alert an Orbit link of up to ${HREF_MAX} characters.`, 400);
  }
  if (landsInSubjectWorkspace(alert.source) && !alert.workspaceId) throw new CrmError("invalid_input", "Say which workspace the alert is about.", 400);
}

async function bellLink(target: UserActor, href: string) {
  const linked = await alertLink(target, href);
  return linked.length <= NOTIFICATION_HREF_MAX ? linked : href;
}

async function record(target: UserActor, alert: TeamAlert) {
  const href = await bellLink(target, alert.href);
  return withActor(target, async (db) => {
    const logged = await db.query("insert into crm.push_log (workspace_id, user_id, key) values ($1, $2, $3) on conflict (user_id, key) do nothing returning id", [
      target.workspaceId,
      target.userId,
      cut(alert.key, 500),
    ]);
    if ((logged.rowCount ?? 0) === 0) return false;
    await db.query("insert into crm.notifications (workspace_id, user_id, title, body, href, source) values ($1, $2, $3, $4, $5, $6)", [
      target.workspaceId,
      target.userId,
      cut(alert.title.trim(), 200),
      alert.body ? cut(alert.body, 4000) : null,
      href,
      alert.source,
    ]);
    return true;
  });
}

async function push(target: UserActor, alert: TeamAlert, options: TeamAlertOptions) {
  if (!(await teamNotifyOn(target))) return 0;
  const badge = await appBadge(target);
  const result = await pushToUser(target, { title: cut(alert.title, 120), body: cut(alert.body ?? "", 400), url: alert.href, tag: cut(alert.tag, 200), badge }, { send: options.send });
  return result.failures.length;
}

async function within(work: Promise<unknown>, stopAt: number) {
  const wait = stopAt - Date.now();
  if (wait <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([work.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), wait)))]);
  if (timer) clearTimeout(timer);
  return finished;
}

export type TeamAlertResult = { alerted: string[]; finished: boolean; pushFailures: number };

export async function alertMembers(actor: Actor, recipients: string[], alert: TeamAlert, options: TeamAlertOptions = {}): Promise<TeamAlertResult> {
  checkAlert(alert);
  const targets = await alertTargets(actor, recipients, alert, options);
  if (targets.length === 0) return { alerted: [], finished: true, pushFailures: 0 };
  const queue = [...targets];
  const fresh: UserActor[] = [];
  const worker = async () => {
    for (let target = queue.shift(); target; target = queue.shift()) {
      try {
        if (await record(target, alert)) fresh.push(target);
      } catch (error) {
        console.error("Teammate alert failed", target.userId, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ALERT_CONCURRENCY, queue.length) }, worker));
  if (fresh.length === 0) return { alerted: [], finished: true, pushFailures: 0 };
  const stopAt = Date.now() + (options.budgetMs ?? ALERT_BUDGET_MS);
  const payload: AlertMessage = { source: alert.source };
  const broadcast = publishLiveBatch(fresh.map((target) => ({ topic: personTopic(target.userId), event: "alert" as const, payload }))).catch((error) =>
    console.error("Teammate alert broadcast failed", error),
  );
  const pushes = Promise.all(
    fresh.map((target) =>
      push(target, alert, options).then(
        (failed) => failed,
        (error) => {
          console.error("Teammate push failed", target.userId, error);
          return 1;
        },
      ),
    ),
  );
  const [finished, failures] = await Promise.all([within(broadcast, stopAt), pushes]);
  if (!finished) console.error("Teammate alert broadcast ran out of time", { source: alert.source, key: alert.key, recipients: fresh.length });
  return { alerted: fresh.map((target) => target.userId), finished, pushFailures: failures.reduce((sum, value) => sum + value, 0) };
}

export function alertMembersAfterCommit(db: Db, actor: Actor, recipients: string[], alert: TeamAlert, options: TeamAlertOptions = {}) {
  checkAlert(alert);
  afterCommit(db, async () => {
    await alertMembers(actor, recipients, alert, options);
  });
}
