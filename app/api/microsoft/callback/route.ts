import { cookies } from "next/headers";
import { after, NextResponse } from "next/server";
import { sessionCookieOptions } from "@/lib/auth/config";
import { getUserActor } from "@/lib/auth/user";
import { syncCalendar } from "@/lib/crm/calendar";
import { finishMicrosoftConnect } from "@/lib/microsoft/connect-flow";
import { originFrom, readMicrosoftState } from "@/lib/microsoft/oauth";
import { SETTINGS_PATHS } from "@/lib/settings-nav";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "crm_ms_oauth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = originFrom(request);
  const cookieStore = await cookies();
  const state = readMicrosoftState(cookieStore.get(STATE_COOKIE)?.value);
  const returned = url.searchParams.get("state");
  const responseState = cookieStore.get(STATE_COOKIE)?.value;
  const forCalendar = state?.purpose === "calendar_account" || state?.purpose === "send_account";
  const toEmail = state ? state.back === "email" : !forCalendar;
  const target = new URL(toEmail ? SETTINGS_PATHS.email : SETTINGS_PATHS.calendars, origin);

  function finish(outcome: { error?: string; connected?: string | null; add?: string | null }) {
    if (!toEmail) {
      if (outcome.error) target.searchParams.set("calendar_error", outcome.error);
      else target.searchParams.set("calendar_connected", outcome.connected ?? "1");
    } else if (outcome.error) {
      target.searchParams.set("error", outcome.error);
      if (outcome.add) target.searchParams.set("add", outcome.add);
    } else if (outcome.connected) target.searchParams.set("info", `Connected ${outcome.connected}.`);
    else target.searchParams.set("connected", "1");
    const response = NextResponse.redirect(target);
    response.cookies.set(STATE_COOKIE, "", sessionCookieOptions(0));
    return response;
  }

  if (!state || !returned || returned !== responseState) {
    return finish({
      error: forCalendar
        ? "The Microsoft connection expired. Start it again from Settings."
        : "The Microsoft connection expired. Start it again from Settings › Email.",
    });
  }
  const user = await getUserActor();
  if (!user || user.userId !== state.userId || user.workspaceId !== state.workspaceId) {
    return finish({ error: "Sign in to the same workspace before connecting Microsoft." });
  }
  const outcome = await finishMicrosoftConnect(user, state, url.searchParams, origin);
  if (outcome.error) return finish(outcome);
  after(async () => {
    try {
      const result = await syncCalendar(user, outcome.accountId ? { force: true, accountId: outcome.accountId } : { force: true });
      if (result.error) console.error("Calendar sync failed", result.error);
    } catch (error) {
      console.error("Calendar sync failed", error);
    }
  });
  return finish(outcome);
}
