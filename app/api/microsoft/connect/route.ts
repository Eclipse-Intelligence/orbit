import { NextResponse } from "next/server";
import { sessionCookieOptions } from "@/lib/auth/config";
import { getUserActor } from "@/lib/auth/user";
import {
  microsoftAuthorizationUrl,
  microsoftConfigured,
  microsoftRedirectOrigin,
  originFrom,
  signMicrosoftState,
} from "@/lib/microsoft/oauth";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "crm_ms_oauth";

export async function GET(request: Request) {
  const origin = originFrom(request);
  const target = microsoftRedirectOrigin();
  const url = new URL(request.url);
  if (target && new URL(target).host !== new URL(origin).host && !url.searchParams.has("hop")) {
    const moved = new URL("/api/microsoft/connect", target);
    moved.searchParams.set("hop", "1");
    return NextResponse.redirect(moved);
  }
  const user = await getUserActor();
  const inbox = new URL("/inbox", origin);
  if (!user) {
    return NextResponse.redirect(new URL("/login", origin));
  }
  if (!microsoftConfigured()) {
    inbox.searchParams.set("error", "Add the Microsoft app credentials before connecting.");
    return NextResponse.redirect(inbox);
  }
  const state = signMicrosoftState(user.userId, user.workspaceId);
  const response = NextResponse.redirect(microsoftAuthorizationUrl(origin, state));
  response.cookies.set(STATE_COOKIE, state, sessionCookieOptions(10 * 60));
  return response;
}
