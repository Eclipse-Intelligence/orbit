"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  RESET_COOKIE,
  SESSION_COOKIE,
  sessionCookieOptions,
  supabaseConfigured,
} from "@/lib/auth/config";
import { signSession } from "@/lib/auth/session";
import { createSupabaseServer } from "@/lib/auth/supabase";
import { membershipsFor, verifyLocalPassword } from "@/lib/auth/user";
import { actionError } from "@/lib/companies";

export type AuthState = {
  error?: string;
  email?: string;
  sent?: boolean;
};

const NO_ACCESS = "This account does not have access to Orbit.";

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function signInAction(
  _state: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = text(formData, "email");
  const password = text(formData, "password");
  const kept = { email };

  if (!email || !password) {
    return { ...kept, error: "Enter your email and password." };
  }

  try {
    if (supabaseConfigured()) {
      const supabase = await createSupabaseServer();
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error || !data.user) {
        return { ...kept, error: "Email or password is incorrect." };
      }
      if ((await membershipsFor(data.user.id)).length === 0) {
        await supabase.auth.signOut();
        return { ...kept, error: NO_ACCESS };
      }
    } else {
      const userId = await verifyLocalPassword(email, password);
      if (!userId) return { ...kept, error: "Email or password is incorrect." };
      if ((await membershipsFor(userId)).length === 0) {
        return { ...kept, error: NO_ACCESS };
      }
      const cookieStore = await cookies();
      cookieStore.set(SESSION_COOKIE, signSession(userId), sessionCookieOptions());
    }
  } catch (error) {
    return { ...kept, ...actionError(error) };
  }

  redirect("/mail");
}

export async function requestResetAction(
  _state: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = text(formData, "email");
  if (!email) return { error: "Enter the email you sign in with." };
  if (!supabaseConfigured()) return { email, error: "Password resets aren't available on this server." };
  const origin = (await headers()).get("origin") ?? process.env.NEXT_PUBLIC_SITE_URL ?? "";
  try {
    const supabase = await createSupabaseServer();
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/callback` });
  } catch {
    return { email, error: "The reset email couldn't be sent. Try again in a minute." };
  }
  const cookieStore = await cookies();
  cookieStore.set(RESET_COOKIE, "1", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60, path: "/" });
  return { email, sent: true };
}
