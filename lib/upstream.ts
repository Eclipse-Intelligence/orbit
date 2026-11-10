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

function detailText(detail: unknown) {
  if (detail === undefined || detail === null || detail === "") return "";
  if (detail instanceof Error) return detail.message;
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}

export function logUpstream(provider: string, status: number | null, detail?: unknown) {
  console.error(`${provider} request failed`, status ?? "no status", detailText(detail));
}

export async function upstreamFailure(provider: string, response: Response, options: UpstreamOptions = {}) {
  const body = await response.text().catch(() => "");
  logUpstream(provider, response.status, body);
  return upstreamMessage(provider, response.status, options);
}
