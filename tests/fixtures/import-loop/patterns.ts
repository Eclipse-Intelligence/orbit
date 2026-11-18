import { describeSender } from "./senders";

export const AUTOMATED = "^no-?reply@";

function automated(address: string): boolean {
  return new RegExp(AUTOMATED).test(address) && describeSender(address) !== "";
}

export function referencedCheck(address: string): boolean {
  return automated(address);
}

export function directCheck(address: string): boolean {
  return automated(address);
}

export function iifeCheck(address: string): boolean {
  return automated(address);
}

export function callbackCheck(address: string): boolean {
  return automated(address);
}

export function localCheck(address: string): boolean {
  return automated(address);
}

export function laterCheck(address: string): boolean {
  return automated(address);
}

export function passedCheck(address: string): boolean {
  return automated(address);
}

export function classCheck(address: string): boolean {
  return automated(address);
}

export function methodCheck(address: string): boolean {
  return automated(address);
}
