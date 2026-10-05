import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { sessionCookieOptions } from "@/lib/auth/config";
import { getUserActor } from "@/lib/auth/user";
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
  const inbox = new URL("/inbox", origin);
  const cookieStore = await cookies();
  const state = readMicrosoftState(cookieStore.get(STATE_COOKIE)?.value);
  const returned = url.searchParams.get("state");
  const responseState = cookieStore.get(STATE_COOKIE)?.value;

  function finish(error?: string) {
    if (error) inbox.searchParams.set("error", error);
    else inbox.searchParams.set("connected", "1");
    const response = NextResponse.redirect(inbox);
    response.cookies.set(STATE_COOKIE, "", sessionCookieOptions(0));
    return response;
  }

  if (!state || !returned || returned !== responseState) {
    return finish("The Microsoft connection expired. Start it again from the inbox.");
  }
  const user = await getUserActor();
  if (!user || user.userId !== state.userId || user.workspaceId !== state.workspaceId) {
    return finish("Sign in to the same workspace before connecting Microsoft.");
  }
  const providerError = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (providerError) return finish(sanitizeMicrosoftError(providerError));
  const code = url.searchParams.get("code");
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
    await syncMailbox(user);
  } catch (error) {
    return finish(
      sanitizeMicrosoftError(error instanceof Error ? error.message : "Could not connect Microsoft."),
    );
  }
  return finish();
}
