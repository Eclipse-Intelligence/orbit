import { mailResponse } from "@/app/api/mail/respond";
import { composeAccounts } from "@/lib/mail/compose";

export const dynamic = "force-dynamic";

export async function GET() {
  return mailResponse(async (actor) => ({ accounts: await composeAccounts(actor) }));
}
