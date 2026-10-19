import JoinForm from "@/components/auth/join-form";
import { previewInvite } from "@/lib/crm/team";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Join Orbit",
  robots: { index: false, follow: false },
};

const CLOSED: Record<string, string> = {
  accepted: "This invite has already been used. Sign in with the email and password you chose.",
  revoked: "This invite was cancelled. Ask whoever invited you for a new one.",
  expired: "This invite has expired. Ask whoever invited you for a new one.",
};

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await previewInvite(token);
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      {invite && invite.status === "pending" ? (
        <JoinForm
          token={token}
          email={invite.email}
          workspaceName={invite.workspaceName}
          invitedBy={invite.invitedBy}
        />
      ) : (
        <div className="border-border bg-card flex w-full max-w-[420px] flex-col gap-3 rounded-2xl border p-6">
          <h1>Invite unavailable</h1>
          <p className="text-muted-foreground">{invite ? CLOSED[invite.status] : "This invite link isn't valid."}</p>
          <a href="/login" className="text-foreground underline underline-offset-2">
            Go to sign in
          </a>
        </div>
      )}
    </main>
  );
}
