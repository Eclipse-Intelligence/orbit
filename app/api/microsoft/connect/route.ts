import { NextResponse } from "next/server";
import { sessionCookieOptions } from "@/lib/auth/config";
import { getUserActor } from "@/lib/auth/user";
import { canonicalEmail } from "@/lib/crm/normalize";
import {
  microsoftAuthorizationUrl,
  microsoftConfigured,
  microsoftPurpose,
  microsoftRedirectOrigin,
  originFrom,
  signMicrosoftState,
  type MicrosoftPurpose,
} from "@/lib/microsoft/oauth";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "crm_ms_oauth";

function connectReturnPath(purpose: MicrosoftPurpose) {
  return purpose === "mailbox" ? "/inbox" : SETTINGS_PATHS.calendars;
}

export async function GET(request: Request) {
  const origin = originFrom(request);
  const target = microsoftRedirectOrigin();
  const url = new URL(request.url);
  if (target && new URL(target).host !== new URL(origin).host && !url.searchParams.has("hop")) {
    const moved = new URL("/api/microsoft/connect", target);
    moved.search = url.search;
    moved.searchParams.set("hop", "1");
    return NextResponse.redirect(moved);
  }
  const purpose: MicrosoftPurpose = microsoftPurpose(url.searchParams.get("purpose"));
  const user = await getUserActor();
  const back = new URL(connectReturnPath(purpose), origin);
  if (!user) {
    return NextResponse.redirect(new URL("/login", origin));
  }
  if (!microsoftConfigured()) {
    back.searchParams.set(
      purpose === "mailbox" ? "error" : "calendar_error",
      "Add the Microsoft app credentials before connecting.",
    );
    return NextResponse.redirect(back);
  }
  const state = signMicrosoftState(user.userId, user.workspaceId, Date.now(), purpose);
  const response = NextResponse.redirect(
    microsoftAuthorizationUrl(origin, state, {
      purpose,
      loginHint: canonicalEmail(url.searchParams.get("hint") ?? ""),
    }),
  );
  response.cookies.set(STATE_COOKIE, state, sessionCookieOptions(10 * 60));
  return response;
}
