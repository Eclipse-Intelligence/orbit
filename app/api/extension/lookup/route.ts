import { extensionJson, extensionOptions, requireExtension } from "@/lib/extension/http";
import { extensionActors } from "@/lib/extension/pairing";
import { lookupPage } from "@/lib/extension/records";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return extensionJson(request, async () => {
    const auth = await requireExtension(request);
    const params = new URL(request.url).searchParams;
    const value = (key: string) => params.get(key) ?? undefined;
    return {
      body: await lookupPage(await extensionActors(auth), {
        url: params.get("url") ?? "",
        linkedinUrl: value("linkedinUrl"),
        name: value("name"),
        company: value("company"),
        companyUrl: value("companyUrl"),
        domain: value("domain"),
      }),
    };
  });
}

export function OPTIONS(request: Request) {
  return extensionOptions(request);
}
