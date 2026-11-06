import { NextResponse } from "next/server";
import { WORKSPACE_COOKIE, sessionCookieOptions } from "@/lib/auth/config";
import { getWorkspaceChoices } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

const RECORD_PATH = /^\/(companies|contacts)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const to = url.searchParams.get("to") ?? "";
  const workspace = url.searchParams.get("workspace") ?? "";
  const choices = await getWorkspaceChoices();
  if (choices.length === 0) return NextResponse.redirect(new URL("/login", url));
  const response = NextResponse.redirect(new URL(RECORD_PATH.test(to) ? to : "/", url));
  if (choices.some((choice) => choice.id === workspace)) {
    response.cookies.set(WORKSPACE_COOKIE, workspace, sessionCookieOptions(60 * 60 * 24 * 365));
  }
  return response;
}
