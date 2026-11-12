import type { SendPayload } from "@/components/mail/mail-composer";

export class HandOverError extends Error {
  payload: SendPayload;
  constructor(message: string, payload: SendPayload) {
    super(message);
    this.payload = payload;
  }
}

export function handOverPayload(error: unknown) {
  return error instanceof HandOverError ? error.payload : null;
}
