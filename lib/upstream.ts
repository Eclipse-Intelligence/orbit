export type UpstreamOptions = {
  credential?: string;
  fix?: string;
  busy?: string;
};

export function unreachable(provider: string) {
  return `Couldn't reach ${provider}. Try again.`;
}

export function upstreamMessage(provider: string, status: number, options: UpstreamOptions = {}) {
  if (status === 401 || status === 403) {
    return [`${provider} rejected the ${options.credential ?? "key"}.`, options.fix].filter(Boolean).join(" ");
  }
  if (status === 429) return `${provider} is busy. ${options.busy ?? "Try again in a minute."}`;
  if (status <= 0 || status === 408 || status >= 500) return unreachable(provider);
  return `${provider} returned an error (${status}).`;
}

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD)$/;

function secretValues() {
  return Object.entries(process.env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.trim().length >= 6)
    .map(([, value]) => value!.trim());
}

export function redactSecrets(text: string, extra: (string | null | undefined)[] = []) {
  let clean = text;
  for (const value of [...secretValues(), ...extra.filter((item): item is string => typeof item === "string" && item.trim().length >= 6)]) {
    clean = clean.split(value.trim()).join("[redacted]");
  }
  return clean
    .replace(/\b(wss?|https?):\/\/[^\s"'<>]*[?&](api[_-]?key|key|(?:refresh_|id_|access_)?token|signature|sig|(?:client_)?secret|password|code)=[^\s"'<>]*/gi, "$1://[redacted url]")
    .replace(/\b(wss?|https?|ftp|postgres(?:ql)?|redis|mongodb(?:\+srv)?):\/\/[^\s/@:"'<>]+:[^\s/@"'<>]+@/gi, "$1://[redacted]@")
    .replace(/(?<![A-Za-z0-9])((?:refresh_|id_|access_)?token|(?:client_)?secret|api[ _-]?key|apikey|key|signature|password|passwd)(["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi, "$1$2[redacted]")
    .replace(/\bBearer\s+[^\s"',}]+/gi, "Bearer [redacted]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=._-]{6,}/gi, "Basic [redacted]")
    .replace(/\b(sk|pk|rk)[-_](live|test|proj)?[-_]?[A-Za-z0-9]{8,}/g, "[redacted]");
}

function detailText(detail: unknown, secrets: (string | null | undefined)[] = []) {
  if (detail === undefined || detail === null || detail === "") return "";
  const text = detail instanceof Error ? `${detail.name}: ${detail.message}` : typeof detail === "string" ? detail : JSON.stringify(detail);
  return redactSecrets((text ?? "").replace(/\s+/g, " ").trim(), secrets).slice(0, 500);
}

export function redactedError(error: unknown) {
  return detailText(error) || String(error);
}

export function clipReason(reason: unknown, max = 200) {
  if (typeof reason !== "string") return "";
  const text = redactSecrets(reason.replace(/\s+/g, " ").trim()).slice(0, max).trim();
  return text.replace(/[.\s]+$/, "");
}

export function logUpstream(provider: string, status: number | null, detail?: unknown, secrets: (string | null | undefined)[] = []) {
  console.error(`${provider} request failed`, status ?? "no status", detailText(detail, secrets));
}

export async function upstreamFailure(provider: string, response: Response, options: UpstreamOptions = {}) {
  const body = await response.text().catch(() => "");
  logUpstream(provider, response.status, body);
  return upstreamMessage(provider, response.status, options);
}
