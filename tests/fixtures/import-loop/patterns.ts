import { describeSender } from "./senders";

export const AUTOMATED = "^no-?reply@";

export function isAutomated(address: string) {
  return new RegExp(AUTOMATED).test(address) && describeSender(address) !== "";
}
