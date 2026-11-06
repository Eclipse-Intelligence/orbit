import { WORKSPACE_HEADER, type LookupQuery, type LookupResponse } from "../../lib/extension/protocol";
import { ORBIT_URL, TOKEN_KEY } from "./config";

export class OrbitError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readToken(): Promise<string | null> {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  const token = stored[TOKEN_KEY];
  return typeof token === "string" && token ? token : null;
}

type CallOptions = { method?: "GET" | "POST"; body?: unknown; token?: string | null; workspaceId?: string | null };

export async function call<T>(path: string, options: CallOptions = {}): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.workspaceId) headers[WORKSPACE_HEADER] = options.workspaceId;
  let response: Response;
  try {
    response = await fetch(`${ORBIT_URL}${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new OrbitError(0, "offline", "Couldn't reach Orbit. Check your connection and try again.");
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = data && typeof data === "object" ? (data as { error?: { code?: string; message?: string } }).error : undefined;
    throw new OrbitError(response.status, error?.code ?? "error", error?.message ?? "Orbit couldn't do that. Try again.");
  }
  return { status: response.status, data: data as T };
}

export function lookupPath(query: LookupQuery) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (typeof value === "string" && value.trim()) params.set(key, value.trim());
  return `/api/extension/lookup?${params.toString()}`;
}

export async function lookup(token: string, query: LookupQuery) {
  return (await call<LookupResponse>(lookupPath(query), { token })).data;
}
