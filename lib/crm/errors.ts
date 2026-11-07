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

export function isPgDataError(error: unknown) {
  return isPgError(error) && /^22[0-9A-Z]{3}$/.test(error.code);
}

export function itemFailure(error: unknown): { code: string; message: string } | null {
  if (error instanceof CrmError) return { code: error.code, message: error.message };
  if (isPgDataError(error)) {
    return { code: "invalid_input", message: "A value in this item is invalid. Check its dates, numbers and ids." };
  }
  if (isPgError(error) && /^23[0-9A-Z]{3}$/.test(error.code)) {
    return { code: "conflict", message: "This item clashes with an existing record or points at one that doesn't exist." };
  }
  return null;
}
