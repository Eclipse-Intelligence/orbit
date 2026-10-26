import { NextResponse, type NextRequest } from "next/server";
import { RESET_COOKIE, supabaseConfigured } from "@/lib/auth/config";
import { createSupabaseServer } from "@/lib/auth/supabase";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (code && supabaseConfigured()) {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const resetting = request.cookies.get(RESET_COOKIE)?.value === "1";
      const response = NextResponse.redirect(new URL(resetting ? "/reset-password" : "/mail", request.url));
      if (resetting) response.cookies.delete(RESET_COOKIE);
      return response;
    }
  }
  return NextResponse.redirect(new URL("/login?confirmed=1", request.url));
}
