import { mailResponse } from "@/app/api/mail/respond";
import { pushPublicKey } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function GET() {
  return mailResponse(async () => ({ publicKey: await pushPublicKey() }));
}
