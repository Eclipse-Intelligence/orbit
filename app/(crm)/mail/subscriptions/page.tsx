import { redirect } from "next/navigation";
import SubscriptionsScreen from "@/components/mail/subscriptions-screen";
import { getUserActor } from "@/lib/auth/user";
import { listSubscriptions } from "@/lib/mail/subscriptions";

export const dynamic = "force-dynamic";

export default async function SubscriptionsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const listed = await listSubscriptions(user);

  return (
    <SubscriptionsScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      initial={listed.senders}
      days={listed.days}
    />
  );
}
