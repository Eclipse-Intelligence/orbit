import { handleMailNotifications } from "@/lib/mail/notifications";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleMailNotifications(request);
}
