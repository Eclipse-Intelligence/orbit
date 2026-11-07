import { NextResponse } from "next/server";
import { WORKSPACE_COOKIE, sessionCookieOptions } from "@/lib/auth/config";
import { getWorkspaceChoices } from "@/lib/auth/user";
import { safeOpenTarget } from "@/lib/open-link";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const to = url.searchParams.get("to") ?? "";
  const workspace = url.searchParams.get("workspace") ?? "";
  const choices = await getWorkspaceChoices();
  if (choices.length === 0) {
    const login = new URL("/login", url);
    login.searchParams.set("next", `${url.pathname}${url.search}`);
    return NextResponse.redirect(login);
  }
  const response = NextResponse.redirect(new URL(safeOpenTarget(to) ?? "/", url));
  if (choices.some((choice) => choice.id === workspace)) {
    response.cookies.set(WORKSPACE_COOKIE, workspace, sessionCookieOptions(60 * 60 * 24 * 365));
  }
  return response;
}
