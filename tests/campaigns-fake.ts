export type FakeLead = {
  id: string;
  email: string;
  first: string;
  last: string;
  company?: string;
  website?: string;
  linkedin?: string;
  status?: string;
  created?: string;
};

export type FakeStat = {
  lead_id?: string;
  lead_email: string;
  lead_name: string;
  sequence_number: number;
  sent_time?: string;
  open_time?: string;
  click_time?: string;
  reply_time?: string;
  is_bounced?: boolean;
  is_unsubscribed?: boolean;
  lead_category?: string | null;
};

export type FakeCampaign = {
  id: number;
  name: string;
  status: string;
  leads: FakeLead[];
  stats: FakeStat[];
  sequences: unknown[];
  analytics: Record<string, unknown>;
  mailboxes?: unknown[];
  threads?: Record<string, unknown[]>;
};

export type FakeWrite = { method: string; path: string; body: Record<string, unknown> | null };

export type FakeAccount = {
  key: string;
  client: { id: number; name: string };
  campaigns: FakeCampaign[];
  calls: URL[];
  fail?: (url: URL) => Response | null;
  writes?: FakeWrite[];
  categories?: { id: number; name: string }[];
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function latest(stat: FakeStat) {
  return [stat.sent_time, stat.open_time, stat.click_time, stat.reply_time]
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .reduce((top, value) => Math.max(top, value), 0);
}

export function fakeSmartlead(accounts: FakeAccount[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://server.smartlead.ai") throw new Error(`Unexpected request to ${url.origin}`);
    const account = accounts.find((item) => item.key === url.searchParams.get("api_key"));
    if (!account) return json({ message: "Invalid API key" }, 401);
    account.calls.push(url);
    const failure = account.fail?.(url);
    if (failure) return failure;
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      (account.writes ??= []).push({ method, path, body });
      const status = path.match(/^\/campaigns\/(\d+)\/status$/);
      if (status) {
        const campaign = account.campaigns.find((item) => String(item.id) === status[1]);
        if (campaign && body) campaign.status = String(body.status) === "START" ? "ACTIVE" : String(body.status);
      }
      if (path.match(/^\/campaigns\/\d+\/webhooks$/)) return json({ id: 77 });
      return json({ ok: true });
    }
    if (path === "/leads/fetch-categories") return json(account.categories ?? [{ id: 1, name: "Interested" }, { id: 2, name: "Not Interested" }, { id: 3, name: "Out Of Office" }, { id: 4, name: "Meeting Booked" }]);
    const history = path.match(/^\/campaigns\/(\d+)\/leads\/([^/]+)\/message-history$/);
    if (history) {
      const campaign = account.campaigns.find((item) => String(item.id) === history[1]);
      return json({ history: campaign?.threads?.[decodeURIComponent(history[2])] ?? [] });
    }
    if (path === "/campaigns") {
      return json(account.campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name, status: campaign.status, client_id: account.client.id })));
    }
    if (path === "/client/") return json([account.client]);
    const match = path.match(/^\/campaigns\/(\d+)\/(sequences|analytics|leads|leads-statistics|email-accounts)$/);
    const campaign = match ? account.campaigns.find((item) => String(item.id) === match[1]) : null;
    if (!match || !campaign) return json({ message: "Not found" }, 404);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 100);
    if (match[2] === "sequences") return json(campaign.sequences);
    if (match[2] === "analytics") return json(campaign.analytics);
    if (match[2] === "email-accounts") return json(campaign.mailboxes ?? []);
    if (match[2] === "leads") {
      return json({
        total_leads: String(campaign.leads.length),
        offset,
        limit,
        data: campaign.leads.slice(offset, offset + limit).map((lead, index) => ({
          campaign_lead_map_id: offset + index + 1,
          status: lead.status ?? "INPROGRESS",
          created_at: lead.created ?? "2026-11-01T09:00:00.000Z",
          lead: {
            id: lead.id,
            first_name: lead.first,
            last_name: lead.last,
            email: lead.email,
            company_name: lead.company ?? null,
            website: lead.website ?? null,
            linkedin_profile: lead.linkedin ?? null,
          },
        })),
      });
    }
    const since = url.searchParams.get("event_time_gt");
    const rows = campaign.stats.filter((stat) => !since || latest(stat) > Date.parse(since));
    return json({ data: rows.slice(offset, offset + limit), offset, limit });
  };
}

export function sequenceOf(steps: { subject: string; body: string; variants?: { label: string; subject: string; body: string }[]; delay?: number }[]) {
  return steps.map((step, index) => ({
    id: 1000 + index,
    seq_number: index + 1,
    seq_delay_details: { delay_in_days: step.delay ?? 0 },
    subject: step.subject,
    email_body: step.body,
    sequence_variants: (step.variants ?? []).map((variant, position) => ({
      id: 2000 + index * 10 + position,
      variant_label: variant.label,
      subject: variant.subject,
      email_body: variant.body,
    })),
  }));
}

export type FakeHeyReachLead = {
  id: string;
  profileUrl: string;
  first: string;
  last: string;
  company?: string;
  position?: string;
  accountId?: number;
  status?: string;
  connection?: "None" | "ConnectionSent" | "ConnectionAccepted";
  messages?: number;
  lastActionTime?: string;
  created?: string;
};

export type FakeHeyReachMessage = { createdAt: string; body: string; sender: "ME" | "CORRESPONDENT" };

export type FakeConversation = {
  id: string;
  accountId: number;
  profileUrl: string;
  leadId?: string;
  messages: FakeHeyReachMessage[];
  tags?: string[];
};

export type FakeHeyReachCampaign = {
  id: number;
  name: string;
  status: string;
  accountIds: number[];
  sequence: unknown;
  leads: FakeHeyReachLead[];
  overall: Record<string, number>;
  byDay: Record<string, Record<string, number>>;
  conversations?: FakeConversation[];
  listId?: number;
  listLeads?: { profileUrl: string; firstName: string; lastName: string; companyName?: string; position?: string }[];
  progress?: Record<string, number>;
};

const HEYREACH_TIME_FILTERS = ["CreationTime", "Everywhere", "LastActionTakenTime", "FailedTime", "LastActionTakenOrFailedTime"];

function sequenceTree(sequence: unknown): Record<string, unknown> | null {
  const steps = Array.isArray(sequence) ? (sequence as Record<string, unknown>[]) : [];
  let node: Record<string, unknown> = { nodeType: "END" };
  for (const step of [...steps].reverse()) {
    const type = String(step.actionType ?? "").replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
    const next = { nodeType: type, actionDelay: step.delayInDays ?? 0, actionDelayUnit: "DAY", payload: { messages: [step.message ?? ""] } };
    node = type === "CONNECTION_REQUEST" ? { ...next, conditionalNode: node, unconditionalNode: { nodeType: "END" } } : { ...next, unconditionalNode: node };
  }
  return steps.length > 0 ? node : null;
}

export type FakeHeyReachAccount = {
  key: string;
  accounts: { id: number; firstName: string; lastName: string; emailAddress: string | null; profileUrl: string; connectionRequestsDailyLimit?: number }[];
  campaigns: FakeHeyReachCampaign[];
  calls: { path: string; body: Record<string, unknown> | null }[];
  fail?: (path: string) => Response | null;
};

function page<T>(items: T[], body: Record<string, unknown> | null) {
  const offset = Number(body?.offset ?? 0);
  const limit = Number(body?.limit ?? 100);
  return { totalCount: items.length, items: items.slice(offset, offset + limit) };
}

export function fakeHeyReach(accounts: FakeHeyReachAccount[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://api.heyreach.io") throw new Error(`Unexpected request to ${url.origin}`);
    if (url.searchParams.has("api_key")) throw new Error("The key must not be in the URL");
    const key = new Headers(init?.headers).get("x-api-key");
    const account = accounts.find((item) => item.key === key);
    if (!account) return json({ message: "Unauthorized" }, 401);
    const path = url.pathname.replace(/^\/api\/public/, "");
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    account.calls.push({ path, body });
    const failure = account.fail?.(path);
    if (failure) return failure;
    if (path === "/auth/CheckApiKey") return new Response(null, { status: 200 });
    if (path === "/inbox/GetConversationsV2") {
      const filters = (body?.filters ?? {}) as { campaignIds?: unknown[]; leadProfileUrl?: string };
      const ids = (filters.campaignIds ?? []).map(String);
      const wanted = filters.leadProfileUrl ? filters.leadProfileUrl.toLowerCase().replace(/\/$/, "") : null;
      const conversations = account.campaigns
        .filter((campaign) => ids.length === 0 || ids.includes(String(campaign.id)))
        .flatMap((campaign) => campaign.conversations ?? [])
        .filter((conversation) => !wanted || conversation.profileUrl.toLowerCase().replace(/\/$/, "").replace("://linkedin", "://www.linkedin") === wanted)
        .map((conversation) => ({
          id: conversation.id,
          linkedInAccountId: conversation.accountId,
          lastMessageAt: conversation.messages[conversation.messages.length - 1]?.createdAt ?? null,
          correspondentProfile: { profileUrl: conversation.profileUrl, id: conversation.leadId ?? null },
          leadTags: conversation.tags ?? [],
          messages: conversation.messages,
        }));
      return json(page(conversations, body));
    }
    if (path === "/inbox/SendMessage" || path === "/campaign/Pause" || path === "/campaign/Resume" || path === "/campaign/StopLeadInCampaign") {
      if (path === "/campaign/Pause" || path === "/campaign/Resume") {
        const campaign = account.campaigns.find((item) => String(item.id) === url.searchParams.get("campaignId"));
        if (campaign) campaign.status = path === "/campaign/Pause" ? "PAUSED" : "IN_PROGRESS";
      }
      return new Response(null, { status: 200 });
    }
    if (path === "/webhooks/CreateWebhook") return json({ id: 55 });
    if (path === "/campaign/GetAll") {
      return json(page(account.campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name, status: campaign.status, campaignAccountIds: campaign.accountIds })), body));
    }
    if (path === "/li_account/GetAll") return json(page(account.accounts, body));
    if (path === "/campaign/GetById") {
      const campaign = account.campaigns.find((item) => String(item.id) === url.searchParams.get("campaignId"));
      return campaign
        ? json({
            id: campaign.id,
            name: campaign.name,
            status: campaign.status,
            campaignAccountIds: campaign.accountIds,
            linkedInUserListId: campaign.listId ?? null,
            ...(campaign.progress ? { progressStats: campaign.progress } : {}),
          })
        : json({ message: "Not found" }, 404);
    }
    if (path === "/campaign/GetCampaignSequence") {
      const campaign = account.campaigns.find((item) => String(item.id) === url.searchParams.get("campaignId"));
      if (!campaign) return json({ errorMessage: "Campaign not found" }, 404);
      const tree = sequenceTree(campaign.sequence);
      return tree ? json(tree) : new Response(null, { status: 200 });
    }
    if (path === "/list/GetLeadsFromList") {
      const campaign = account.campaigns.find((item) => item.listId !== undefined && String(item.listId) === String(body?.listId));
      if (!campaign) return json({ errorMessage: "List not found" }, 404);
      return json(page(campaign.listLeads ?? [], body));
    }
    if (path === "/stats/GetOverallStats") {
      const ids = ((body?.campaignIds as unknown[] | undefined) ?? []).map(String);
      const campaign = account.campaigns.find((item) => ids.includes(String(item.id)));
      return campaign ? json({ overallStats: campaign.overall, byDayStats: campaign.byDay }) : json({ message: "Not found" }, 404);
    }
    if (path === "/campaign/GetLeadsFromCampaign") {
      const campaign = account.campaigns.find((item) => String(item.id) === String(body?.campaignId));
      if (!campaign) return json({ message: "Not found" }, 404);
      if (body?.timeFilter !== undefined && !HEYREACH_TIME_FILTERS.includes(String(body.timeFilter))) {
        return json({ errorMessage: `The value '${String(body.timeFilter)}' is not valid for timeFilter.` }, 400);
      }
      const since = typeof body?.timeFrom === "string" ? Date.parse(body.timeFrom) : null;
      const leads = campaign.leads.filter((lead) => since === null || Date.parse(lead.lastActionTime ?? lead.created ?? "2026-11-01T09:00:00.000Z") > since);
      return json(
        page(
          leads.map((lead) => ({
            id: lead.id,
            linkedInSenderId: lead.accountId ?? null,
            leadCampaignStatus: lead.status ?? "InSequence",
            leadConnectionStatus: lead.connection ?? "None",
            leadMessageStatus: (lead.messages ?? 0) > 0 ? "MessageSent" : "None",
            messagesSent: lead.messages ?? 0,
            lastActionTime: lead.lastActionTime ?? null,
            creationTime: lead.created ?? "2026-11-01T09:00:00.000Z",
            linkedInUserProfile: { firstName: lead.first, lastName: lead.last, profileUrl: lead.profileUrl, companyName: lead.company ?? null, position: lead.position ?? null },
          })),
          body,
        ),
      );
    }
    return json({ message: "Not found" }, 404);
  };
}
