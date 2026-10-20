import { after } from "next/server";
import { alertFirstRead } from "@/lib/mail/read-alert";
import { recordOpen } from "@/lib/mail/tracking";

export const dynamic = "force-dynamic";

const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trackingId = id.replace(/\.gif$/i, "");
  try {
    const recorded = await recordOpen(trackingId, request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip"), request.headers.get("user-agent"));
    if (recorded) {
      after(async () => {
        try {
          await alertFirstRead(trackingId);
        } catch (error) {
          console.error("read alert failed", error);
        }
      });
    }
  } catch (error) {
    console.error("mail open failed", error);
  }
  return new Response(PIXEL, {
    headers: {
      "content-type": "image/gif",
      "content-length": String(PIXEL.byteLength),
      "cache-control": "no-store, no-cache, must-revalidate, private",
      "referrer-policy": "no-referrer",
    },
  });
}
