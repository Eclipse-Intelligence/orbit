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
};

export type FakeAccount = {
  key: string;
  client: { id: number; name: string };
  campaigns: FakeCampaign[];
  calls: URL[];
  fail?: (url: URL) => Response | null;
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
  return async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://server.smartlead.ai") throw new Error(`Unexpected request to ${url.origin}`);
    const account = accounts.find((item) => item.key === url.searchParams.get("api_key"));
    if (!account) return json({ message: "Invalid API key" }, 401);
    account.calls.push(url);
    const failure = account.fail?.(url);
    if (failure) return failure;
    const path = url.pathname.replace(/^\/api\/v1/, "");
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
