import { errorResponse, readJson } from "@/lib/api/http";
import { bookSlot, clientIp, type BookingInput } from "@/lib/booking/book";
import { CrmError } from "@/lib/crm/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 20_000) {
      throw new CrmError("invalid_input", "That request is too large.", 413);
    }
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new CrmError("invalid_input", "Request body must be a JSON object.", 400);
    }
    const booking = await bookSlot(slug, body as BookingInput, { ip: clientIp(request.headers) });
    return Response.json({ booking }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
