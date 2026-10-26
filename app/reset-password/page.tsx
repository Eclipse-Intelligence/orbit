import { redirect } from "next/navigation";
import ResetPasswordForm from "@/components/auth/reset-password-form";
import { getUserActor } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Choose a new password",
  robots: { index: false, follow: false },
};

export default async function ResetPasswordPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <ResetPasswordForm email={user.email} />
    </main>
  );
}
