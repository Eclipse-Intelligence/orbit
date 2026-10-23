import type { Actor } from "@/lib/crm/types";
import { MindcaseError, runMindcase, slimLinkedInCompany, slimLinkedInPost, slimLinkedInProfile, slimTweet, slimXProfile } from "@/lib/mindcase";

function xHandle(value: string) {
  const trimmed = value.trim();
  const fromUrl = trimmed.match(/(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})/i)?.[1];
  const handle = fromUrl ?? trimmed.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new MindcaseError("That isn't an X handle or profile link.");
  return handle;
}

function linkedInUrl(value: string, kind: "in" | "company" | "any") {
  const trimmed = value.trim();
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`;
  const match = url.match(/^https?:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/(in|company|school|posts|feed)\/[^\s?#]+/i);
  if (!match || (kind !== "any" && match[3].toLowerCase() !== kind)) {
    throw new MindcaseError(kind === "company" ? "That isn't a LinkedIn company link (linkedin.com/company/...)." : kind === "in" ? "That isn't a LinkedIn profile link (linkedin.com/in/...)." : "That isn't a LinkedIn link.");
  }
  return match[0];
}

export async function socialLookup(actor: Actor, kind: string, target: string, limit = 5, options: { fetchImpl?: typeof fetch; source?: string } = {}) {
  const count = Math.min(Math.max(Math.round(limit) || 5, 1), 10);
  const run = { fetchImpl: options.fetchImpl, source: options.source ?? "assistant" };
  if (kind === "linkedin_profile") {
    const rows = await runMindcase(actor, "linkedin/profiles", { queries: [linkedInUrl(target, "in")] }, { ...run, expectedRows: 1 });
    return rows[0] ? { profile: slimLinkedInProfile(rows[0]) } : { error: "LinkedIn returned nothing for that profile." };
  }
  if (kind === "linkedin_company") {
    const rows = await runMindcase(actor, "linkedin/companies", { companies: [linkedInUrl(target, "company")] }, { ...run, expectedRows: 1 });
    return rows[0] ? { company: slimLinkedInCompany(rows[0]) } : { error: "LinkedIn returned nothing for that company." };
  }
  if (kind === "linkedin_posts") {
    const rows = await runMindcase(
      actor,
      "linkedin/posts",
      { urls: linkedInUrl(target, "any"), maxResults: count, postedLimit: "3months", sortBy: "date", includeReposts: false },
      { ...run, expectedRows: count },
    );
    return { posts: rows.slice(0, count).map(slimLinkedInPost) };
  }
  if (kind === "x_profile") {
    const rows = await runMindcase(actor, "twitter/profiles", { inputs: [xHandle(target)], maxResults: 1 }, { ...run, expectedRows: 1 });
    return rows[0] ? { profile: slimXProfile(rows[0]) } : { error: "X returned nothing for that handle." };
  }
  if (kind === "x_posts") {
    const rows = await runMindcase(actor, "twitter/tweets", { inputs: xHandle(target), maxResults: count }, { ...run, expectedRows: count });
    return { posts: rows.slice(0, count).map(slimTweet) };
  }
  throw new MindcaseError("Choose linkedin_profile, linkedin_company, linkedin_posts, x_profile or x_posts.");
}
