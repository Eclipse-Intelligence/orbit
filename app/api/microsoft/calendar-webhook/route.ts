import { handleCalendarNotifications } from "@/lib/crm/calendar-notify";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleCalendarNotifications(request);
}
