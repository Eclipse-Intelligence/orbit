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

const REASON_FIELDS = ["errorMessage", "message", "error", "detail", "title", "error_message", "msg", "description"];
const REASON_MAX = 160;

function reasonIn(value: unknown, depth = 0): string | null {
  if (depth > 3 || value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const found = value.map((item) => reasonIn(item, depth + 1)).filter((item): item is string => Boolean(item));
    return found.length > 0 ? found.slice(0, 3).join(" ") : null;
  }
  if (typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  for (const field of REASON_FIELDS) {
    const found = reasonIn(row[field], depth + 1);
    if (found) return found;
  }
  if (row.errors && typeof row.errors === "object") {
    const parts = Object.entries(row.errors as Record<string, unknown>).flatMap(([name, item]) => {
      const text = reasonIn(item, depth + 1);
      return text ? [Array.isArray(row.errors) ? text : `${name}: ${text}`] : [];
    });
    if (parts.length > 0) return parts.slice(0, 3).join(" ");
  }
  return null;
}

export function scrubPersonal(text: string) {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s"'<>,)]*/gi, "[profile]")
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[link]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]");
}

export function providerReason(body: string, secrets: (string | null | undefined)[] = []) {
  const raw = body.trim();
  if (!raw) return null;
  let found: string | null = null;
  try {
    found = reasonIn(JSON.parse(raw));
  } catch {
    found = raw.startsWith("<") ? null : raw;
  }
  if (!found) return null;
  const clean = scrubPersonal(redactSecrets(found.replace(/\s+/g, " ").trim(), secrets)).trim().replace(/[.\s]+$/, "");
  if (!clean) return null;
  return clean.length > REASON_MAX ? `${clean.slice(0, REASON_MAX - 1).trimEnd()}…` : clean;
}

export function requestPath(url: URL) {
  return url.pathname.replace(/\/{2,}/g, "/");
}

export function logRefusal(provider: string, status: number, path: string, reason: string | null) {
  console.error(`${provider} request failed`, status, path, reason ?? "no reason given");
}

export function refusedMessage(provider: string, status: number, reason: string | null, where?: string | null) {
  const base = upstreamMessage(provider, status);
  if (status === 401 || status === 403 || status === 429 || status >= 500 || status < 400) return base;
  const head = `${base.replace(/\.$/, "")}${where ? ` on ${where}` : ""}`;
  return reason ? `${head}: ${reason}.` : `${head}.`;
}

export async function upstreamFailure(provider: string, response: Response, options: UpstreamOptions = {}) {
  const body = await response.text().catch(() => "");
  logUpstream(provider, response.status, body);
  return upstreamMessage(provider, response.status, options);
}

export function urlSecrets(url: string) {
  const secret = new URL(url).searchParams.get("secret");
  return secret ? [url, secret] : [url];
}
