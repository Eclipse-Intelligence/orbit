export class CrmError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | null;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "CrmError";
    this.code = code;
    this.status = status;
    this.details = details ?? null;
  }
}

export function isPgError(
  error: unknown,
): error is { code: string; constraint?: string; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  );
}
