import { CrmError } from "@/lib/crm/errors";

export async function readJson(request: Request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CrmError("invalid_input", "Request body must be JSON.", 400);
  }
}

export function idempotencyKey(request: Request) {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return null;
  if (key.length > 200 || !/^[\x21-\x7E]+$/.test(key)) {
    throw new CrmError("invalid_input", "Idempotency-Key is invalid.", 400);
  }
  return key;
}

export function errorResponse(error: unknown) {
  if (error instanceof CrmError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
      {
        status: error.status,
        headers: error.status === 429 ? { "retry-after": "60" } : undefined,
      },
    );
  }
  console.error(process.env.NODE_ENV === "production" ? "request_failed" : error);
  return Response.json(
    { error: { code: "internal_error", message: "Something went wrong." } },
    { status: 500 },
  );
}

export async function withApi<T>(run: () => Promise<T> | T) {
  try {
    return await run();
  } catch (error) {
    return errorResponse(error);
  }
}
