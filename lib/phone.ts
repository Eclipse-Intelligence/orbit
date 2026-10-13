const DEFAULT_COUNTRY_CODE = "44";

export function normalizePhone(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  const plus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (!plus) {
    if (digits.startsWith("00")) digits = digits.slice(2);
    else if (digits.startsWith("0")) digits = DEFAULT_COUNTRY_CODE + digits.slice(1);
    else if (digits.length <= 10) digits = DEFAULT_COUNTRY_CODE + digits;
  }
  if (digits.startsWith("440")) digits = "44" + digits.slice(3);
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export function teamsCallUrl(value: string | null | undefined) {
  const number = normalizePhone(value);
  return number ? `msteams:/l/call/0/0?users=4:${encodeURIComponent(number)}` : null;
}
