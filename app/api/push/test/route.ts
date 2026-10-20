import { mailResponse } from "@/app/api/mail/respond";
import { pushToUser } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function POST() {
  return mailResponse((actor) =>
    pushToUser(actor, { title: "Orbit", body: "Notifications are working on this device.", url: "/mail", tag: "orbit-test" }),
  );
}
