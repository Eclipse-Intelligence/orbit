import { handleMetaLeadsWebhook, handleMetaVerification } from "@/lib/crm/meta-leads";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET(request: Request) {
  return handleMetaVerification(request);
}

export async function POST(request: Request) {
  return handleMetaLeadsWebhook(request);
}
