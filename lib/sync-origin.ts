export const SYNC_ORIGIN_HEADER = "x-orbit-origin";

const ORIGIN_PATTERN = /^[0-9a-f-]{36}$/;

let tabOrigin: string | null = null;

export function syncOrigin() {
  if (!tabOrigin) tabOrigin = crypto.randomUUID();
  return tabOrigin;
}

export function readSyncOrigin(headers: Headers) {
  const value = headers.get(SYNC_ORIGIN_HEADER)?.trim().toLowerCase() ?? "";
  return ORIGIN_PATTERN.test(value) ? value : null;
}
