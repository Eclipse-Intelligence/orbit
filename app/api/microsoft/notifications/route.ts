import { handleNotificationRequest } from "@/lib/crm/teams-transcripts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleNotificationRequest(request);
}
