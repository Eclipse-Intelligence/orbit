import { CrmError } from "@/lib/crm/errors";
import { quickCapture, readQuickCapture } from "@/lib/quick-capture";

export const runtime = "nodejs";
export const maxDuration = 30;

function reply(message: string, status = 200) {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

async function body(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return request.json().catch(() => null);
  if (type.includes("form")) return Object.fromEntries((await request.formData()).entries());
  return request.text();
}

export async function POST(request: Request) {
  try {
    return reply(await quickCapture(request, readQuickCapture(await body(request))));
  } catch (error) {
    if (error instanceof CrmError) return reply(error.message, error.status);
    console.error("Quick capture failed", error);
    return reply("Orbit couldn't add that. Try again.", 500);
  }
}

export function GET() {
  return reply("Send text to Orbit with POST. See Settings, API and webhooks, iPhone Shortcut.", 405);
}
