"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  supabaseConfigured,
} from "@/lib/auth/config";
import { signSession } from "@/lib/auth/session";
import { createSupabaseServer } from "@/lib/auth/supabase";
import {
  createLocalUser,
  ensurePersonalWorkspace,
  verifyLocalPassword,
} from "@/lib/auth/user";
import { actionError } from "@/lib/companies";

export type AuthState = { error?: string };

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
  const name = text(formData, "name");
  const mode = text(formData, "mode") === "signup" ? "signup" : "signin";

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  try {
    if (supabaseConfigured()) {
      const supabase = await createSupabaseServer();
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: name || undefined } },
        });
        if (error) return { error: error.message };
        if (!data.user) {
          return { error: "Check your email to confirm the account." };
        }
        await ensurePersonalWorkspace(data.user.id);
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error || !data.user) {
          return { error: "Email or password is incorrect." };
        }
        await ensurePersonalWorkspace(data.user.id);
      }
    } else {
      const userId =
        mode === "signup"
          ? await createLocalUser(email, password, name || email)
          : await verifyLocalPassword(email, password);
      if (!userId) return { error: "Email or password is incorrect." };
      await ensurePersonalWorkspace(userId);
      const cookieStore = await cookies();
      cookieStore.set(SESSION_COOKIE, signSession(userId), sessionCookieOptions());
    }
  } catch (error) {
    return actionError(error);
  }

  redirect("/");
}
