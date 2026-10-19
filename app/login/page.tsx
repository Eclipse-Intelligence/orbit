import { redirect } from "next/navigation";
import LoginForm from "@/components/auth/login-form";
import { supabaseConfigured } from "@/lib/auth/config";
import { getUserActor } from "@/lib/auth/user";

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
  if (user) redirect("/");
  const { confirmed } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <LoginForm
        notice={confirmed ? "Email confirmed. Sign in to continue." : undefined}
        hintEmail={
          process.env.NODE_ENV === "production" || supabaseConfigured()
            ? undefined
            : process.env.DEV_USER_EMAIL
        }
      />
    </main>
  );
}
