import { BOOKING_SLUG_MAX, checkSlug } from "@/lib/booking/rules";

export const ENDING_TAKEN = "Taken. Pick another.";
export const ENDING_AVAILABLE = "Available.";

export function typeEnding(raw: string) {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, BOOKING_SLUG_MAX);
}

export function settleEnding(raw: string) {
  return typeEnding(raw).replace(/-+$/, "");
}

export function endingProblem(raw: string) {
  const checked = checkSlug(raw);
  return checked.ok ? null : checked.error;
}

export type EndingStatus = { status: "available" } | { status: "taken" } | { status: "invalid"; message: string };
