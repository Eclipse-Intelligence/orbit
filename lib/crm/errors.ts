export class ShownError extends Error {}

export class CrmError extends ShownError {
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

function capitalise(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function notFoundMessage(noun: string) {
  return `${capitalise(noun.trim())} not found.`;
}

export function notFound(noun: string, details?: Record<string, unknown> | null) {
  return new CrmError("not_found", notFoundMessage(noun), 404, details);
}

type Viewer = { type?: string; role?: string } | null | undefined;

export function notSetUp(thing: string, env?: string | null, viewer?: Viewer) {
  const owner = viewer?.type !== "agent" && viewer?.role === "owner";
  if (env && !owner) console.error(`${thing} isn't set up: ${env} is missing.`);
  return `${capitalise(thing)} isn't set up.${env && owner ? ` Add ${env}.` : ""}`;
}

function count(value: number) {
  return value.toLocaleString("en-GB");
}

export function tooLong(field: string, max: number) {
  return `Keep ${field} to ${count(max)} characters.`;
}

export function tooMany(max: number, things: string) {
  return `Up to ${count(max)} ${things}.`;
}

export function errorText(error: unknown, fallback: string) {
  if (error instanceof ShownError) {
    const text = error.message.replace(/\s+/g, " ").trim().slice(0, 500);
    if (text) return text;
  }
  if (error !== undefined && error !== null) console.error(fallback || "Unexpected error", error);
  return fallback;
}

export function writtenForPeople(message: string | null | undefined) {
  const text = message?.trim() ?? "";
  return text.length > 1 && text.length <= 300 && !text.includes("\n") && /^[A-Z]/.test(text) && text.endsWith(".");
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

const PG_FAILURES: Record<string, { code: string; status: number; message: string }> = {
  "42501": { code: "forbidden", status: 403, message: "You don't have permission to do that." },
  "22023": { code: "invalid_input", status: 400, message: "That isn't valid." },
  P0002: { code: "not_found", status: 404, message: "Not found." },
  "23505": { code: "conflict", status: 409, message: "A matching record already exists." },
  "23514": { code: "invalid_input", status: 400, message: "That isn't valid." },
  "23503": { code: "invalid_input", status: 400, message: "That record isn't in this workspace." },
};

export function pgFailure(error: unknown, messages: Partial<Record<string, string>> = {}): CrmError | null {
  if (error instanceof CrmError) return error;
  if (!isPgError(error)) return null;
  const known = PG_FAILURES[error.code];
  if (!known) return null;
  if (writtenForPeople(error.message)) return new CrmError(known.code, error.message.trim(), known.status);
  console.error("Database refused the change", error.code, error.message);
  return new CrmError(known.code, messages[error.code] ?? known.message, known.status);
}

export function itemFailure(error: unknown): { code: string; message: string } | null {
  if (error instanceof CrmError) return { code: error.code, message: error.message };
  if (isPgDataError(error)) {
    return { code: "invalid_input", message: "A value in this item is invalid. Check its dates, numbers and ids." };
  }
  if (isPgError(error) && /^23[0-9A-Z]{3}$/.test(error.code)) {
    return { code: "conflict", message: "This item duplicates a record or links to a missing one." };
  }
  return null;
}
