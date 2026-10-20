import { NextResponse, type NextRequest } from "next/server";
import { supabaseConfigured } from "@/lib/auth/config";
import { createSupabaseServer } from "@/lib/auth/supabase";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (code && supabaseConfigured()) {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/mail", request.url));
  }
  return NextResponse.redirect(new URL("/login?confirmed=1", request.url));
}
