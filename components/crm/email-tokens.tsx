"use client";

import Button from "@/components/_ui/button";
import { PERSONAL_TOKENS, unknownTokens } from "@/lib/crm/personalise";

export function insertToken(
  target: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
  token: string,
  apply: (next: string) => void,
) {
  const text = `{{${token}}}`;
  const start = target?.selectionStart ?? value.length;
  const end = target?.selectionEnd ?? value.length;
  apply(value.slice(0, start) + text + value.slice(end));
  requestAnimationFrame(() => {
    target?.focus();
    target?.setSelectionRange(start + text.length, start + text.length);
  });
}

export function TokenChips({
  onInsert,
  text,
  unknownNote = "Not a token, sent as typed",
}: {
  onInsert: (token: string) => void;
  text: string;
  unknownNote?: string;
}) {
  const unknown = unknownTokens(text);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="caption-style text-subtle">
        Personalise with a token. Click one to insert it where you are typing.
      </p>
      <ul className="flex flex-wrap gap-1">
        {PERSONAL_TOKENS.map((item) => (
          <li key={item.token}>
            <Button
              variant="subtle"
              size="sm"
              title={item.label}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onInsert(item.token)}
              className="font-mono"
            >
              {`{{${item.token}}}`}
            </Button>
          </li>
        ))}
      </ul>
      <p className="caption-style text-subtle">
        {"{{first_name}}"} falls back to the full name, then “there”.
      </p>
      {unknown.length > 0 && (
        <p className="caption-style text-warning">
          {unknownNote}: {unknown.join(", ")}
        </p>
      )}
    </div>
  );
}
