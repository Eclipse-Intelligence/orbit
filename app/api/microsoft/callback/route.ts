import { cookies } from "next/headers";
import { after, NextResponse } from "next/server";
import { sessionCookieOptions } from "@/lib/auth/config";
import { getUserActor } from "@/lib/auth/user";
import { resetCalendarSync, syncCalendar } from "@/lib/crm/calendar";
import {
  calendarConnectError,
  connectCalendarAccount,
  removeAccountsForEmail,
} from "@/lib/crm/calendar-accounts";
import { CrmError } from "@/lib/crm/errors";
import { saveMailbox, syncMailbox } from "@/lib/crm/inbox";
import {
  exchangeAuthorizationCode,
  fetchMicrosoftProfile,
  originFrom,
  readMicrosoftState,
  sanitizeMicrosoftError,
} from "@/lib/microsoft/oauth";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "crm_ms_oauth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = originFrom(request);
  const cookieStore = await cookies();
  const state = readMicrosoftState(cookieStore.get(STATE_COOKIE)?.value);
  const returned = url.searchParams.get("state");
  const responseState = cookieStore.get(STATE_COOKIE)?.value;
  const forCalendar = state?.purpose === "calendar_account";
  const target = new URL(forCalendar ? "/settings" : "/inbox", origin);

  function finish(error?: string, connected?: string) {
    if (forCalendar) {
      if (error) target.searchParams.set("calendar_error", error);
      else target.searchParams.set("calendar_connected", connected ?? "1");
      target.hash = "calendars";
    } else if (error) target.searchParams.set("error", error);
    else target.searchParams.set("connected", "1");
    const response = NextResponse.redirect(target);
    response.cookies.set(STATE_COOKIE, "", sessionCookieOptions(0));
    return response;
  }

  if (!state || !returned || returned !== responseState) {
    return finish(
      forCalendar
        ? "The Microsoft connection expired. Start it again from Settings."
        : "The Microsoft connection expired. Start it again from the inbox.",
    );
  }
  const user = await getUserActor();
  if (
    !user ||
    user.userId !== state.userId ||
    user.workspaceId !== state.workspaceId
  ) {
    return finish("Sign in to the same workspace before connecting Microsoft.");
  }
  const providerError = [
    url.searchParams.get("error"),
    url.searchParams.get("error_subcode"),
    url.searchParams.get("error_description"),
  ]
    .filter(Boolean)
    .join(" ");
  const code = url.searchParams.get("code");

  if (forCalendar) {
    if (providerError) return finish(calendarConnectError(providerError));
    if (!code) return finish("Microsoft did not return a connection code.");
    let account: Awaited<ReturnType<typeof connectCalendarAccount>>;
    try {
      account = await connectCalendarAccount(user, { origin, code });
    } catch (error) {
      return finish(
        error instanceof CrmError
          ? error.message
          : calendarConnectError(error instanceof Error ? error.message : null),
      );
    }
    after(async () => {
      try {
        const result = await syncCalendar(user, {
          force: true,
          accountId: account.id,
        });
        if (result.error)
          console.error("Calendar account sync failed", result.error);
      } catch (error) {
        console.error("Calendar account sync failed", error);
      }
    });
    return finish(undefined, account.email);
  }

  if (providerError)
    return finish(
      sanitizeMicrosoftError(
        url.searchParams.get("error_description") ||
          url.searchParams.get("error") ||
          providerError,
      ),
    );
  if (!code) return finish("Microsoft did not return a connection code.");

  try {
    const token = await exchangeAuthorizationCode(origin, code);
    const email = await fetchMicrosoftProfile(token.accessToken);
    await saveMailbox(user, {
      email,
      refreshToken: token.refreshToken,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
    });
    await removeAccountsForEmail(user, email);
    await resetCalendarSync(user);
    await syncMailbox(user);
  } catch (error) {
    return finish(
      sanitizeMicrosoftError(
        error instanceof Error ? error.message : "Could not connect Microsoft.",
      ),
    );
  }
  after(async () => {
    try {
      const result = await syncCalendar(user, { force: true });
      if (result.error) console.error("Calendar sync failed", result.error);
    } catch (error) {
      console.error("Calendar sync failed", error);
    }
  });
  return finish();
}
