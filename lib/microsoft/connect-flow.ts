import { resetCalendarSync } from "@/lib/crm/calendar";
import { calendarConnectError, connectCalendarAccount } from "@/lib/crm/calendar-accounts";
import { CrmError } from "@/lib/crm/errors";
import { getMailbox, saveMailbox, syncMailbox } from "@/lib/crm/inbox";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";
import {
  exchangeAuthorizationCode,
  fetchMicrosoftIdentity,
  microsoftAuthorizationUrl,
  microsoftPurpose,
  microsoftReturn,
  sanitizeMicrosoftError,
  signMicrosoftState,
  type MicrosoftPurpose,
  type MicrosoftReturn,
} from "@/lib/microsoft/oauth";

export type MicrosoftConnectState = { userId: string; workspaceId: string; purpose: MicrosoftPurpose; hint: string | null; back: MicrosoftReturn };

export type MicrosoftConnectOutcome = {
  error?: string;
  add?: string | null;
  connected?: string | null;
  accountId?: string | null;
};

export async function startMicrosoftConnect(user: UserActor, params: URLSearchParams, origin: string, now = Date.now()) {
  const purpose = microsoftPurpose(params.get("purpose"));
  const back = microsoftReturn(params.get("from"), purpose);
  const main = purpose === "mailbox" ? await getMailbox(user) : null;
  const hint = canonicalEmail(purpose === "mailbox" ? (main?.email ?? "") : (params.get("hint") ?? "")) || null;
  const state = signMicrosoftState(user.userId, user.workspaceId, now, purpose, { hint, back });
  return { state, back, purpose, url: microsoftAuthorizationUrl(origin, state, { purpose, loginHint: hint }) };
}

function addOffer(error: unknown) {
  const add = error instanceof CrmError ? error.details?.add : null;
  return typeof add === "string" && add ? add : null;
}

export async function finishMicrosoftConnect(
  user: UserActor,
  state: MicrosoftConnectState,
  params: URLSearchParams,
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MicrosoftConnectOutcome> {
  const providerError = [params.get("error"), params.get("error_subcode"), params.get("error_description")].filter(Boolean).join(" ");
  const code = params.get("code");
  if (state.purpose !== "mailbox") {
    if (providerError) return { error: calendarConnectError(providerError) };
    if (!code) return { error: "Microsoft did not return a connection code." };
    try {
      const account = await connectCalendarAccount(user, { origin, code, purpose: state.purpose, expected: state.hint }, fetchImpl);
      return { connected: account.email, accountId: account.id };
    } catch (error) {
      return {
        error: error instanceof CrmError ? error.message : calendarConnectError(error instanceof Error ? error.message : null),
        add: addOffer(error),
      };
    }
  }
  if (providerError) return { error: sanitizeMicrosoftError(params.get("error_description") || params.get("error") || providerError) };
  if (!code) return { error: "Microsoft did not return a connection code." };
  try {
    const token = await exchangeAuthorizationCode(origin, code, fetchImpl);
    const identity = await fetchMicrosoftIdentity(token.accessToken, fetchImpl);
    await saveMailbox(user, {
      email: identity.email,
      refreshToken: token.refreshToken,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      expected: state.hint,
      microsoftUserId: identity.id,
      tenantId: token.tenantId ?? null,
      aliases: identity.aliases,
    });
    await resetCalendarSync(user, token.scope);
    await syncMailbox(user, fetchImpl);
    return {};
  } catch (error) {
    if (error instanceof CrmError) return { error: error.message, add: addOffer(error) };
    return { error: sanitizeMicrosoftError(error instanceof Error ? error.message : "Could not connect Microsoft.") };
  }
}
