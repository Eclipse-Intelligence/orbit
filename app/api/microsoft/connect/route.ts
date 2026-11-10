import { NextResponse } from "next/server";
import { sessionCookieOptions } from "@/lib/auth/config";
import { getUserActor } from "@/lib/auth/user";
import { getMailbox } from "@/lib/crm/inbox";
import { canonicalEmail } from "@/lib/crm/normalize";
import {
  microsoftAuthorizationUrl,
  microsoftConfigured,
  microsoftPurpose,
  microsoftRedirectOrigin,
  microsoftReturn,
  originFrom,
  signMicrosoftState,
  type MicrosoftPurpose,
  type MicrosoftReturn,
} from "@/lib/microsoft/oauth";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "crm_ms_oauth";

function connectReturnPath(back: MicrosoftReturn) {
  return back === "email" ? SETTINGS_PATHS.email : SETTINGS_PATHS.calendars;
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
  const returnTo = microsoftReturn(url.searchParams.get("from"), purpose);
  const user = await getUserActor();
  const back = new URL(connectReturnPath(returnTo), origin);
  if (!user) {
    return NextResponse.redirect(new URL("/login", origin));
  }
  if (!microsoftConfigured()) {
    back.searchParams.set(
      returnTo === "email" ? "error" : "calendar_error",
      "Add the Microsoft app credentials before connecting.",
    );
    return NextResponse.redirect(back);
  }
  const main = purpose === "mailbox" ? await getMailbox(user) : null;
  const hint = canonicalEmail(main?.email ?? url.searchParams.get("hint") ?? "") || null;
  const state = signMicrosoftState(user.userId, user.workspaceId, Date.now(), purpose, { hint, back: returnTo });
  const response = NextResponse.redirect(microsoftAuthorizationUrl(origin, state, { purpose, loginHint: hint }));
  response.cookies.set(STATE_COOKIE, state, sessionCookieOptions(10 * 60));
  return response;
}
