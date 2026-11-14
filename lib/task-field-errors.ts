export type TaskField = "title" | "text" | "due" | "reminder" | "duration" | "other";

export type TaskWrite = {
  title?: unknown;
  description?: unknown;
  dueAt?: unknown;
  dueDate?: unknown;
  dueHasTime?: unknown;
  remindMinutes?: unknown;
  durationMinutes?: unknown;
};

export function unsavedDraftError(draft: { title?: string; text?: string } | undefined) {
  const fields = draftFields(draft);
  return fields.length > 0 ? saveFailedMessage(fields) : null;
}

export function saveFailedMessage(fields: TaskField[]) {
  const named = [fields.includes("title") && "title", fields.includes("text") && "description"].filter(Boolean);
  return named.length > 0 && named.length === fields.length ? `Couldn't save your ${named.join(" and ")}. Try again.` : "Couldn't save. Try again.";
}

export function draftFields(draft: { title?: string; text?: string } | undefined): TaskField[] {
  if (!draft) return [];
  return [...(draft.title !== undefined ? (["title"] as const) : []), ...(draft.text !== undefined ? (["text"] as const) : [])];
}

export function fieldsOf(write: TaskWrite): TaskField[] {
  const fields: TaskField[] = [];
  if (write.title !== undefined) fields.push("title");
  if (write.description !== undefined) fields.push("text");
  if (write.dueAt !== undefined || write.dueDate !== undefined || write.dueHasTime !== undefined) fields.push("due");
  if (write.remindMinutes !== undefined) fields.push("reminder");
  if (write.durationMinutes !== undefined) fields.push("duration");
  return fields;
}

export type FieldErrors = { message: string; fields: TaskField[] }[];

export function failFields(errors: FieldErrors, fields: TaskField[], message: string): FieldErrors {
  const rest = errors.map((entry) => ({ ...entry, fields: entry.fields.filter((field) => !fields.includes(field)) })).filter((entry) => entry.fields.length > 0);
  return [...rest, { message, fields }];
}

export function clearFields(errors: FieldErrors, fields: TaskField[]): FieldErrors {
  const next = errors.map((entry) => ({ ...entry, fields: entry.fields.filter((field) => !fields.includes(field)) })).filter((entry) => entry.fields.length > 0);
  return next.length === errors.length && next.every((entry, index) => entry.fields.length === errors[index].fields.length) ? errors : next;
}

export type DraftNews = { kept: boolean; draft: string; saved: string };

export function draftReaction(news: DraftNews, local: string, sent: string): "adopt" | "restore" | "clear" | "ignore" {
  if (news.kept) return local !== news.draft && local === sent ? "adopt" : "ignore";
  if (local === news.draft && news.draft !== news.saved) return "restore";
  return local === news.saved ? "clear" : "ignore";
}

export function fieldError(errors: FieldErrors) {
  return errors.at(-1)?.message ?? null;
}
