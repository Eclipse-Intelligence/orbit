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
import { membershipsFor, verifyLocalPassword } from "@/lib/auth/user";
import { actionError } from "@/lib/companies";

export type AuthState = {
  error?: string;
  email?: string;
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

  redirect("/");
}
