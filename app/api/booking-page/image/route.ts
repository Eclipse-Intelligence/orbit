import { errorResponse } from "@/lib/api/http";
import { getUserActor } from "@/lib/auth/user";
import { readImageKind, readOwnImage, removeBookingImage, saveBookingImage } from "@/lib/booking/pages";
import { BOOKING_IMAGE_MAX_BYTES } from "@/lib/booking/rules";
import { CrmError } from "@/lib/crm/errors";

export const dynamic = "force-dynamic";

function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return;
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {}
  if (originHost !== host) throw new CrmError("forbidden", "Upload from Orbit's settings page.", 403);
}

async function requireUser() {
  const user = await getUserActor();
  if (!user) throw new CrmError("unauthorized", "Sign in again.", 401);
  return user;
}

function kindFrom(request: Request) {
  const kind = readImageKind(new URL(request.url).searchParams.get("kind"));
  if (!kind) throw new CrmError("invalid_input", "Choose avatar or poster.", 400);
  return kind;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const image = await readOwnImage(user, kindFrom(request));
    if (!image) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(image.data), {
      headers: {
        "content-type": image.mime,
        "cache-control": "private, max-age=60",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const kind = kindFrom(request);
    if (Number(request.headers.get("content-length") ?? 0) > BOOKING_IMAGE_MAX_BYTES + 64_000) {
      throw new CrmError("invalid_input", "Use an image under 1 MB.", 413, { field: kind });
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") {
      throw new CrmError("invalid_input", "Choose an image.", 400, { field: kind });
    }
    if (file.size > BOOKING_IMAGE_MAX_BYTES) {
      throw new CrmError("invalid_input", "Use an image under 1 MB.", 400, { field: kind });
    }
    const saved = await saveBookingImage(user, kind, new Uint8Array(await file.arrayBuffer()));
    return Response.json(saved);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    return Response.json(await removeBookingImage(user, kindFrom(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
