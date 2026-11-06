import type { MatchStatus } from "../../lib/extension/protocol";
import type { ReadResult, ReadWhat } from "./parsers";

export type ReadMessage = { type: "orbit:read"; what: ReadWhat };

export type ReadReply = { ok: true; result: ReadResult } | { ok: false; error: string };

type BadgeMessage = { type: "orbit:badge"; tabId: number; url: string; status: MatchStatus };

type SignedOutMessage = { type: "orbit:signed-out" };

export type BackgroundMessage = BadgeMessage | SignedOutMessage;

export function isReadMessage(value: unknown): value is ReadMessage {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "orbit:read");
}

export function isBackgroundMessage(value: unknown): value is BackgroundMessage {
  const type = value && typeof value === "object" ? (value as { type?: unknown }).type : null;
  return type === "orbit:badge" || type === "orbit:signed-out";
}
