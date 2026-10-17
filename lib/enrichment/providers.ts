export type ProviderId = "context" | "hunter" | "enrow" | "icypeas";

export type ContactField = "email" | "linkedin" | "phone";

export type PersonQuery = {
  firstName: string;
  lastName: string;
  domain: string | null;
  companyName: string | null;
  linkedinUrl: string | null;
};

export type Finding = {
  email: string | null;
  emailVerified: boolean;
  emailScore: number | null;
  linkedinUrl: string | null;
  phone: string | null;
  jobTitle: string | null;
  companyDomain: string | null;
  matchScore: number | null;
};

export type Verdict = "valid" | "invalid" | "unknown";

export type ProviderContext = { key: string; fetchImpl: typeof fetch; deadline: number; pollMs?: number };

export type Provider = {
  id: ProviderId;
  name: string;
  envKey: string;
  fields: ContactField[];
  find: (query: PersonQuery, field: ContactField, context: ProviderContext) => Promise<Finding | null>;
  verify?: (email: string, context: ProviderContext) => Promise<Verdict>;
};

export class ProviderFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderFailure";
  }
}

const CALL_TIMEOUT_MS = 30_000;
const POLL_MS = 2_500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function empty(): Finding {
  return { email: null, emailVerified: false, emailScore: null, linkedinUrl: null, phone: null, jobTitle: null, companyDomain: null, matchScore: null };
}

function remaining(context: ProviderContext) {
  return Math.max(1_000, Math.min(CALL_TIMEOUT_MS, context.deadline - Date.now()));
}

async function call(
  provider: string,
  context: ProviderContext,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown },
) {
  let response: Response;
  try {
    response = await context.fetchImpl(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(remaining(context)),
    });
  } catch {
    throw new ProviderFailure(`${provider} didn't respond.`);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {}
  if (response.status === 401) throw new ProviderFailure(`${provider} rejected the API key.`);
  if (response.status === 403) throw new ProviderFailure(`${provider} refused the request.`);
  if (response.status === 402) throw new ProviderFailure(`${provider} is out of credits.`);
  if (response.status === 429) throw new ProviderFailure(`${provider} is rate limiting or out of credits.`);
  if (response.status >= 500) throw new ProviderFailure(`${provider} had a server error.`);
  return { status: response.status, body };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function deepFind(value: unknown, test: (item: Record<string, unknown>) => boolean, depth = 0): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || depth > 8) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFind(item, test, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const item = value as Record<string, unknown>;
  if (test(item)) return item;
  for (const nested of Object.values(item)) {
    const found = deepFind(nested, test, depth + 1);
    if (found) return found;
  }
  return null;
}

function deepStrings(value: unknown, into: string[] = [], depth = 0) {
  if (depth > 8 || into.length > 200) return into;
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) deepStrings(item, into, depth + 1);
  else if (value && typeof value === "object") for (const item of Object.values(value)) deepStrings(item, into, depth + 1);
  return into;
}

export function linkedinProfileIn(value: unknown) {
  return deepStrings(value).find((item) => /^(https?:\/\/)?([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[^/?#\s]+/i.test(item.trim())) ?? null;
}

function domainOf(query: PersonQuery) {
  return query.domain ?? query.companyName ?? "";
}

const context: Provider = {
  id: "context",
  name: "context.dev",
  envKey: "CONTEXT_DEV_API_KEY",
  fields: ["email", "linkedin"],
  async find(query, _field, ctx) {
    const company = query.domain ? { domain: query.domain } : query.companyName ? { name: query.companyName } : null;
    if (!company && !query.linkedinUrl) return null;
    const { status, body } = await call("context.dev", ctx, "https://api.context.dev/v1/people/enrich", {
      headers: { authorization: `Bearer ${ctx.key}` },
      body: {
        name: { first: query.firstName, last: query.lastName },
        ...(company ? { company } : {}),
        ...(query.linkedinUrl ? { social_urls: [query.linkedinUrl] } : {}),
        timeoutOpts: { milliseconds: Math.min(25_000, remaining(ctx)), behavior: "return-partial" },
        tags: ["orbit"],
      },
    });
    if (status === 400 || status === 422) return null;
    const match = record(record(body).match);
    if (match.status !== "candidate") return null;
    const person = record(match.person);
    const role = record(person.current_role);
    const organization = record(role.organization);
    return {
      ...empty(),
      email: text(person.email),
      linkedinUrl: linkedinProfileIn(person.social_urls),
      jobTitle: text(role.title),
      companyDomain: text(organization.domain),
      matchScore: typeof match.score === "number" ? match.score : null,
    };
  },
};

const hunter: Provider = {
  id: "hunter",
  name: "Hunter",
  envKey: "HUNTER_API_KEY",
  fields: ["email", "linkedin"],
  async find(query, _field, ctx) {
    const params = new URLSearchParams({ first_name: query.firstName, last_name: query.lastName, max_duration: "15" });
    if (query.domain) params.set("domain", query.domain);
    else if (query.companyName) params.set("company", query.companyName);
    else return null;
    const { status, body } = await call("Hunter", ctx, `https://api.hunter.io/v2/email-finder?${params}`, { headers: { "x-api-key": ctx.key } });
    if (status !== 200) return null;
    const data = record(record(body).data);
    const email = text(data.email);
    const verification = text(record(data.verification).status);
    const score = typeof data.score === "number" ? data.score : null;
    return {
      ...empty(),
      email,
      emailVerified: Boolean(email && (verification === "valid" || (score !== null && score >= 90))),
      emailScore: score,
      linkedinUrl: text(data.linkedin_url),
      jobTitle: text(data.position),
      companyDomain: text(data.domain),
    };
  },
  async verify(email, ctx) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { status, body } = await call("Hunter", ctx, `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}`, {
        headers: { "x-api-key": ctx.key },
      });
      if (status === 202 || status === 222) {
        if (Date.now() + (ctx.pollMs ?? POLL_MS) > ctx.deadline) return "unknown";
        await sleep(ctx.pollMs ?? POLL_MS);
        continue;
      }
      const result = text(record(record(body).data).status);
      if (result === "valid") return "valid";
      if (result === "invalid" || result === "disposable" || result === "webmail") return "invalid";
      return "unknown";
    }
    return "unknown";
  },
};

async function enrowPoll(ctx: ProviderContext, path: string, id: string) {
  const wait = ctx.pollMs ?? POLL_MS;
  while (Date.now() + wait < ctx.deadline) {
    await sleep(wait);
    const { status, body } = await call("Enrow", ctx, `https://api.enrow.io${path}?id=${encodeURIComponent(id)}`, {
      headers: { "x-api-key": ctx.key },
    });
    if (status === 202 || record(body).qualification === "ongoing") continue;
    return record(body);
  }
  return null;
}

const enrow: Provider = {
  id: "enrow",
  name: "Enrow",
  envKey: "ENROW_API_KEY",
  fields: ["email", "phone"],
  async find(query, field, ctx) {
    const company = query.domain ? { company_domain: query.domain } : query.companyName ? { company_name: query.companyName } : null;
    if (field === "phone") {
      if (!query.linkedinUrl && !company) return null;
      const started = await call("Enrow", ctx, "https://api.enrow.io/phone/single", {
        headers: { "x-api-key": ctx.key },
        body: query.linkedinUrl
          ? { linkedin_url: query.linkedinUrl }
          : { firstname: query.firstName, lastname: query.lastName, ...company },
      });
      const id = text(record(started.body).id);
      if (!id) return null;
      const result = await enrowPoll(ctx, "/phone/single", id);
      if (!result || result.qualification !== "found") return null;
      return { ...empty(), phone: text(result.number) };
    }
    if (!company) return null;
    const started = await call("Enrow", ctx, "https://api.enrow.io/email/find/single", {
      headers: { "x-api-key": ctx.key },
      body: { fullname: `${query.firstName} ${query.lastName}`.trim(), ...company, settings: { country_code: "GB" } },
    });
    const id = text(record(started.body).id);
    if (started.status !== 200 || !id) return null;
    const result = await enrowPoll(ctx, "/email/find/single", id);
    if (!result || result.qualification !== "valid") return null;
    return { ...empty(), email: text(result.email), emailVerified: true };
  },
  async verify(email, ctx) {
    const started = await call("Enrow", ctx, "https://api.enrow.io/email/verify/single", { headers: { "x-api-key": ctx.key }, body: { email } });
    const id = text(record(started.body).id);
    if (!id) return "unknown";
    const result = await enrowPoll(ctx, "/email/verify/single", id);
    if (!result) return "unknown";
    return result.qualification === "valid" ? "valid" : result.qualification === "invalid" ? "invalid" : "unknown";
  },
};

const ICYPEAS_SURE = new Set(["ultra_sure", "very_sure", "probable"]);

async function icypeasResult(ctx: ProviderContext, id: string) {
  const wait = ctx.pollMs ?? POLL_MS * 1.2;
  while (Date.now() + wait < ctx.deadline) {
    await sleep(wait);
    const { body } = await call("Icypeas", ctx, "https://app.icypeas.com/api/bulk-single-searchs/read", {
      headers: { authorization: ctx.key },
      body: { id },
    });
    const item = deepFind(body, (entry) => entry._id === id && typeof entry.status === "string") ?? deepFind(body, (entry) => typeof entry.status === "string");
    const status = text(item?.status);
    if (!status || ["NONE", "SCHEDULED", "IN_PROGRESS"].includes(status)) continue;
    return item;
  }
  return null;
}

function icypeasEmail(item: Record<string, unknown> | null) {
  const found = deepFind(item, (entry) => typeof entry.email === "string" && typeof entry.certainty === "string");
  if (!found) return null;
  return { email: String(found.email), certainty: String(found.certainty) };
}

const icypeas: Provider = {
  id: "icypeas",
  name: "Icypeas",
  envKey: "ICYPEAS_API_KEY",
  fields: ["email", "linkedin"],
  async find(query, field, ctx) {
    const where = domainOf(query);
    if (!where) return null;
    if (field === "linkedin") {
      const { status, body } = await call("Icypeas", ctx, "https://app.icypeas.com/api/url-search/profile", {
        headers: { authorization: ctx.key },
        body: { firstname: query.firstName, lastname: query.lastName, companyOrDomain: where },
      });
      if (status !== 200) return null;
      const url = linkedinProfileIn(body);
      return url ? { ...empty(), linkedinUrl: url } : null;
    }
    const started = await call("Icypeas", ctx, "https://app.icypeas.com/api/email-search", {
      headers: { authorization: ctx.key },
      body: { firstname: query.firstName, lastname: query.lastName, domainOrCompany: where },
    });
    const id = text(record(record(started.body).item)._id);
    if (!id) return null;
    const found = icypeasEmail(await icypeasResult(ctx, id));
    if (!found || !ICYPEAS_SURE.has(found.certainty)) return null;
    return { ...empty(), email: found.email, emailVerified: true };
  },
  async verify(email, ctx) {
    const started = await call("Icypeas", ctx, "https://app.icypeas.com/api/email-verification", {
      headers: { authorization: ctx.key },
      body: { email },
    });
    const id = text(record(record(started.body).item)._id);
    if (!id) return "unknown";
    const item = await icypeasResult(ctx, id);
    const found = icypeasEmail(item);
    if (found && ICYPEAS_SURE.has(found.certainty)) return "valid";
    if (found?.certainty === "undeliverable") return "invalid";
    return "unknown";
  },
};

export const PROVIDERS: Provider[] = [context, hunter, enrow, icypeas];

export const PROVIDER_BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

export const VERIFIER_ORDER: ProviderId[] = ["enrow", "icypeas", "hunter"];

export function providerKey(id: ProviderId, env: Record<string, string | undefined> = process.env) {
  const provider = PROVIDER_BY_ID.get(id);
  return provider ? env[provider.envKey]?.trim() || null : null;
}
