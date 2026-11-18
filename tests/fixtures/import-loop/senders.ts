import { AUTOMATED, isAutomated } from "./patterns";

const NOISE = [AUTOMATED];
const CHECK = isAutomated;

export function describeSender(address: string) {
  return NOISE.some((pattern) => new RegExp(pattern).test(address)) ? "automated" : address;
}

export function laterRead() {
  return CHECK("noreply@example.com") ? AUTOMATED : "";
}
