export type DraftText = { subject: string; body: string };

export type DraftTextChanges = { subject: string | null; body: string | null };

export function sameText(left: DraftText, right: DraftText) {
  return left.subject === right.subject && left.body === right.body;
}

export function reconcileText(base: DraftText, local: DraftText, fresh: DraftText): DraftText {
  return {
    subject: local.subject === base.subject ? fresh.subject : local.subject,
    body: local.body === base.body ? fresh.body : local.body,
  };
}

export function textChanges(base: DraftText, local: DraftText): DraftTextChanges | null {
  if (sameText(base, local)) return null;
  return { subject: local.subject !== base.subject ? local.subject : null, body: local.body !== base.body ? local.body : null };
}

export function newerVersion(seen: number | null, version: number) {
  return seen === null || version >= seen;
}

export function openingBase(base: { text: DraftText } | null, opened: DraftText) {
  return base?.text ?? opened;
}

export function teammateText(base: DraftText | null, local: DraftText, fresh: DraftText, options: { editing: boolean; starting: boolean }): DraftText {
  const subject = options.editing && base && local.subject !== base.subject ? local.subject : fresh.subject;
  return { subject, body: base && !options.starting ? local.body : fresh.body };
}
