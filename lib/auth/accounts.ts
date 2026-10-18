import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { SESSION_COOKIE, WORKSPACE_COOKIE, sessionCookieOptions, supabaseConfigured } from "@/lib/auth/config";
import { signSession } from "@/lib/auth/session";
import { createSupabaseServer } from "@/lib/auth/supabase";
import { verifyLocalPassword } from "@/lib/auth/user";
import { CrmError, isPgError } from "@/lib/crm/errors";
import { query } from "@/lib/db/pool";

export type JoinedAccount = { userId: string; signedIn: boolean; needsConfirmation: boolean };

const EXISTING = "You already have an Orbit login with this email. Enter that password to join.";

function serviceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SECRET_KEY?.trim() || null;
}

function alreadyRegistered(message: string | undefined) {
  return Boolean(message && /already (been )?registered|already exists/i.test(message));
}

async function localAccount(email: string, password: string, fullName: string): Promise<JoinedAccount> {
  try {
    const created = await query<{ id: string }>("select private.create_local_user($1, $2, $3) as id", [email, password, fullName]);
    return { userId: created.rows[0].id, signedIn: false, needsConfirmation: false };
  } catch (error) {
    if (!isPgError(error) || error.code !== "23505") throw error;
    const existing = await verifyLocalPassword(email, password);
    if (!existing) throw new CrmError("invalid_input", EXISTING, 400, { field: "password" });
    return { userId: existing, signedIn: false, needsConfirmation: false };
  }
}

async function existingSupabaseAccount(email: string, password: string): Promise<JoinedAccount> {
  const supabase = await createSupabaseServer();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    if (error && /not confirmed/i.test(error.message)) {
      throw new CrmError("invalid_input", "Confirm your email first using the link we sent, then open this invite again.", 400);
    }
    throw new CrmError("invalid_input", EXISTING, 400, { field: "password" });
  }
  return { userId: data.user.id, signedIn: true, needsConfirmation: false };
}

export async function createJoinAccount(
  input: { email: string; password: string; fullName: string },
  origin: string,
): Promise<JoinedAccount> {
  const { email, password, fullName } = input;
  if (password.length < 8) throw new CrmError("invalid_input", "Use at least 8 characters for your password.", 400, { field: "password" });
  if (!supabaseConfigured()) return localAccount(email, password, fullName);

  const secret = serviceKey();
  if (secret) {
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, secret, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error || !data.user) {
      if (alreadyRegistered(error?.message)) return existingSupabaseAccount(email, password);
      throw new CrmError("upstream_error", error?.message ?? "Couldn't create your login.", 502);
    }
    return { userId: data.user.id, signedIn: false, needsConfirmation: false };
  }

  const supabase = await createSupabaseServer();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName }, emailRedirectTo: `${origin}/auth/callback` },
  });
  if (error) {
    if (alreadyRegistered(error.message)) return existingSupabaseAccount(email, password);
    throw new CrmError("invalid_input", error.message, 400);
  }
  if (!data.user || (data.user.identities && data.user.identities.length === 0)) {
    return existingSupabaseAccount(email, password);
  }
  return { userId: data.user.id, signedIn: Boolean(data.session), needsConfirmation: !data.session };
}

export async function signInJoined(account: JoinedAccount, email: string, password: string, workspaceId: string) {
  const cookieStore = await cookies();
  cookieStore.set(WORKSPACE_COOKIE, workspaceId, sessionCookieOptions(60 * 60 * 24 * 365));
  if (account.needsConfirmation || account.signedIn) return;
  if (!supabaseConfigured()) {
    cookieStore.set(SESSION_COOKIE, signSession(account.userId), sessionCookieOptions());
    return;
  }
  const supabase = await createSupabaseServer();
  await supabase.auth.signInWithPassword({ email, password });
}
