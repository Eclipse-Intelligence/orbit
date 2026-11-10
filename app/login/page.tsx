import { redirect } from "next/navigation";
import LoginForm from "@/components/auth/login-form";
import { supabaseConfigured } from "@/lib/auth/config";
import { getUserActor } from "@/lib/auth/user";
import { safeNextPath } from "@/lib/auth/next-path";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  const { confirmed, next } = await searchParams;
  const after = safeNextPath(typeof next === "string" ? next : null);
  if (user) redirect(after ?? "/mail");

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <LoginForm
        resets={supabaseConfigured()}
        next={after ?? undefined}
        notice={confirmed ? "Email confirmed." : undefined}
        hintEmail={
          process.env.NODE_ENV === "production" || supabaseConfigured()
            ? undefined
            : process.env.DEV_USER_EMAIL
        }
      />
    </main>
  );
}
