import type { ProviderSender } from "@/lib/campaigns/providers";
import type { CampaignProviderId, CampaignSender, SendersView } from "@/lib/campaigns/types";
import { withActor } from "@/lib/crm/context";
import { CrmError, notFound } from "@/lib/crm/errors";
import { isUuid, recordAudit } from "@/lib/crm/mutate";
import type { Actor, Provenance, UserActor } from "@/lib/crm/types";
import { query, type Db } from "@/lib/db/pool";
import { workspaceLink } from "@/lib/open-link";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

export const SENDER_LINKED = "campaign.sender_linked";

type SenderRow = {
  id: string;
  provider: CampaignProviderId;
  external_id: string;
  name: string;
  email: string | null;
  linkedin: string | null;
  user_id: string | null;
  invite_limit: number | null;
  message_limit: number | null;
};

function view(row: SenderRow): CampaignSender {
  return {
    id: row.id,
    externalId: row.external_id,
    name: row.name,
    linkedin: row.linkedin,
    email: row.email,
    userId: row.user_id,
    inviteLimit: row.invite_limit,
    messageLimit: row.message_limit,
  };
}

function isAdmin(actor: Actor): actor is UserActor {
  return actor.type === "user" && (actor.role === "owner" || actor.role === "admin");
}

function linkChanges(provider: string, sender: { id: string; externalId: string; name: string }, linked: string | null, unlinked: string | null) {
  return { provider, sender, linked, unlinked };
}

export async function saveProviderSenders(actor: UserActor, provider: CampaignProviderId, senders: ProviderSender[], provenance?: Provenance) {
  const matched = await query<{ sender_id: string; user_id: string; name: string; external_id: string }>(
    "select * from private.campaign_sync_senders($1, $2, $3::jsonb)",
    [
      actor.workspaceId,
      provider,
      JSON.stringify(
        senders.map((sender) => ({
          external_id: sender.externalId,
          name: sender.name,
          email: sender.email,
          linkedin: sender.linkedin,
          invite_limit: sender.inviteLimit,
          message_limit: sender.messageLimit,
        })),
      ),
    ],
  );
  if (matched.rows.length === 0) return 0;
  await withActor(actor, async (db) => {
    for (const row of matched.rows) {
      await recordAudit(
        db,
        actor,
        SENDER_LINKED,
        "campaign_sender",
        row.sender_id,
        provenance ?? { operation: "match_campaign_sender", source: "sync" },
        { ...linkChanges(provider, { id: row.sender_id, externalId: row.external_id, name: row.name }, row.user_id, null), matched: "email" },
      );
    }
  });
  return matched.rows.length;
}

async function members(db: Db, workspaceId: string) {
  const result = await db.query<{ user_id: string; name: string }>(
    `select m.user_id, coalesce(nullif(btrim(p.full_name), ''), p.email, 'Unnamed') as name
     from crm.workspace_members m
     join crm.profiles p on p.id = m.user_id
     where m.workspace_id = $1
     order by lower(coalesce(nullif(btrim(p.full_name), ''), p.email, '')), m.user_id`,
    [workspaceId],
  );
  return result.rows.map((row) => ({ userId: row.user_id, name: row.name }));
}

export async function listCampaignSenders(actor: Actor, provider: CampaignProviderId = "heyreach"): Promise<SendersView> {
  return withActor(actor, async (db) => {
    const senders = await db.query<SenderRow>(
      `select id, provider, external_id, name, email, linkedin, user_id, invite_limit, message_limit
       from crm.campaign_senders
       where workspace_id = $1 and provider = $2
       order by lower(name), external_id`,
      [actor.workspaceId, provider],
    );
    return {
      senders: senders.rows.map(view),
      members: actor.type === "user" ? await members(db, actor.workspaceId) : [],
      canAdmin: isAdmin(actor),
    };
  });
}

export async function linkCampaignSender(actor: Actor, senderId: string, userId: string | null, provenance: Provenance = { operation: "link_campaign_sender", source: "web" }) {
  if (!isAdmin(actor)) throw new CrmError("forbidden", "Only an owner or admin can link senders.", 403);
  if (!isUuid(senderId)) throw notFound("sender");
  if (userId !== null && !isUuid(userId)) throw new CrmError("invalid_input", "Pick someone in this workspace.", 400, { field: "userId" });
  return withActor(actor, async (db) => {
    const current = await db.query<SenderRow>(
      `select id, provider, external_id, name, email, linkedin, user_id, invite_limit, message_limit
       from crm.campaign_senders where id = $1 and workspace_id = $2 for update`,
      [senderId, actor.workspaceId],
    );
    const sender = current.rows[0];
    if (!sender) throw notFound("sender");
    if (sender.user_id === userId) return view(sender);
    if (userId) {
      const member = await db.query("select 1 from crm.workspace_members where workspace_id = $1 and user_id = $2", [actor.workspaceId, userId]);
      if (member.rowCount === 0) throw new CrmError("invalid_input", "Pick someone in this workspace.", 400, { field: "userId" });
    }
    const updated = await db.query<SenderRow>(
      `update crm.campaign_senders set user_id = $3 where id = $1 and workspace_id = $2
       returning id, provider, external_id, name, email, linkedin, user_id, invite_limit, message_limit`,
      [senderId, actor.workspaceId, userId],
    );
    const saved = updated.rows[0];
    if (!saved) throw notFound("sender");
    await recordAudit(
      db,
      actor,
      SENDER_LINKED,
      "campaign_sender",
      saved.id,
      provenance,
      linkChanges(saved.provider, { id: saved.id, externalId: saved.external_id, name: saved.name }, userId, sender.user_id),
    );
    const label = saved.name || "a LinkedIn account";
    const told = [
      userId ? { user: userId, title: `Linked to ${label} on LinkedIn` } : null,
      sender.user_id ? { user: sender.user_id, title: `Unlinked from ${label} on LinkedIn` } : null,
    ].filter((item): item is { user: string; title: string } => Boolean(item && item.user !== actor.userId));
    for (const item of told) {
      await db.query(
        `insert into crm.notifications (workspace_id, user_id, title, body, href, source)
         select $1, $2, $3, $4, $5, 'campaign'
         where exists (select 1 from crm.workspace_members m where m.workspace_id = $1 and m.user_id = $2)`,
        [actor.workspaceId, item.user, item.title.slice(0, 200), `Changed by ${actor.fullName || actor.email}.`, workspaceLink(actor.workspaceId, `${SETTINGS_PATHS.tools}#heyreach`, 2)],
      );
    }
    return view(saved);
  });
}
