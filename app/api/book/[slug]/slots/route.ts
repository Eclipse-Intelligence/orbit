import { errorResponse } from "@/lib/api/http";
import { clientIp, listSlots } from "@/lib/booking/book";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const url = new URL(request.url);
  try {
    const result = await listSlots(
      slug,
      { month: url.searchParams.get("month"), timeZone: url.searchParams.get("tz") },
      { ip: clientIp(request.headers) },
    );
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
