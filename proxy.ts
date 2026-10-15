import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, supabaseConfigured } from "@/lib/auth/config";
import { legacyRecordHref } from "@/lib/crm/hrefs";
import { legacyTasksHref } from "@/lib/crm/task-views";
import { legacySettingsHref } from "@/lib/settings-nav";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (
    pathname.startsWith("/api") ||
    pathname === "/login" ||
    pathname === "/book" ||
    pathname.startsWith("/book/")
  ) {
    return NextResponse.next();
  }

  const legacy = legacyRecordHref(pathname, request.nextUrl.searchParams);
  if (legacy) return NextResponse.redirect(new URL(legacy, request.url));
  const tasks = legacyTasksHref(pathname, request.nextUrl.searchParams);
  if (tasks) return NextResponse.redirect(new URL(tasks, request.url), 308);
  const settings = legacySettingsHref(pathname, request.nextUrl.searchParams);
  if (settings) return NextResponse.redirect(new URL(settings, request.url));

  if (supabaseConfigured()) {
    let response = NextResponse.next({ request });
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            for (const { name, value } of cookiesToSet) {
              request.cookies.set(name, value);
            }
            response = NextResponse.next({ request });
            for (const { name, value, options } of cookiesToSet) {
              response.cookies.set(name, value, options);
            }
          },
        },
      },
    );
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      return NextResponse.redirect(url);
    }
    return response;
  }

  if (!request.cookies.get(SESSION_COOKIE)?.value) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|webm|riv|json)$).*)",
  ],
};
