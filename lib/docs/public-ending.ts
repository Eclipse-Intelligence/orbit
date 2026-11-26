import { BOOKING_SLUG_MAX, checkSlug } from "@/lib/booking/rules";

export const ENDING_TAKEN = "Taken. Pick another.";
export const ENDING_AVAILABLE = "Available.";
export const ENDING_CHECK_FAILED = "Couldn't check the ending. Try again.";
export const ENDING_BACK_TO_CODE = "Save to go back to the random code.";

export type EndingStatus = { status: "available" } | { status: "taken" } | { status: "invalid"; message: string };
export type EndingAnswer = EndingStatus | { status: "failed"; message: string };

const PATH_MARKER = "/d/";

export function typeEnding(raw: string) {
  const at = raw.lastIndexOf(PATH_MARKER);
  const text = at === -1 ? raw : raw.slice(at + PATH_MARKER.length).split(/[?#]/)[0];
  return text
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

export function caretAfterTyping(raw: string, caret: number) {
  return typeEnding(raw.slice(0, caret)).length;
}

export function endingProblem(raw: string) {
  const checked = checkSlug(raw);
  return checked.ok ? null : checked.error;
}

export type EndingEditorState = {
  value: string;
  current: string | null;
  answer: EndingAnswer | null;
  error: string | null;
  saving: boolean;
  busy: boolean;
};

export type EndingLine = { text: string; tone: "ok" | "bad" | "plain" };

export function endingView(state: Pick<EndingEditorState, "value" | "current">) {
  const settled = settleEnding(state.value);
  const problem = settled === "" ? null : endingProblem(settled);
  return { settled, problem, needsCheck: settled !== "" && problem === null && settled !== state.current, target: settled === "" ? null : settled };
}

export function endingLine(state: EndingEditorState): EndingLine {
  const { settled, problem, needsCheck } = endingView(state);
  if (state.error) return { text: state.error, tone: "bad" };
  if (problem) return { text: problem, tone: "bad" };
  if (settled === "") return { text: state.current ? ENDING_BACK_TO_CODE : "", tone: "plain" };
  if (!needsCheck) return { text: ENDING_AVAILABLE, tone: "ok" };
  const answer = state.answer;
  if (answer === null) return { text: "", tone: "plain" };
  if (answer.status === "available") return { text: ENDING_AVAILABLE, tone: "ok" };
  if (answer.status === "taken") return { text: ENDING_TAKEN, tone: "bad" };
  return { text: answer.message, tone: "bad" };
}

export function endingCanSave(state: EndingEditorState) {
  const { problem, needsCheck, target } = endingView(state);
  if (state.saving || state.busy || problem !== null || target === state.current) return false;
  return !needsCheck || (state.answer !== null && (state.answer.status === "available" || state.answer.status === "failed"));
}

export function endingEnter(state: EndingEditorState): "none" | "check" | "save" {
  const { problem, needsCheck, target } = endingView(state);
  if (state.saving || state.busy || problem !== null || target === state.current) return "none";
  if (!needsCheck) return "save";
  if (state.answer === null) return "check";
  return state.answer.status === "available" || state.answer.status === "failed" ? "save" : "none";
}

export function saveAfterCheck(input: { open: boolean; checkedValue: string; value: string; answer: EndingAnswer }) {
  if (!input.open || settleEnding(input.value) !== input.checkedValue) return false;
  return input.answer.status === "available" || input.answer.status === "failed";
}

export function escapeAction(editing: boolean): "close-editor" | "close-popover" {
  return editing ? "close-editor" : "close-popover";
}
