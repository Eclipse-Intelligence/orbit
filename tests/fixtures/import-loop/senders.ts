import { AUTOMATED, callbackCheck, directCheck, iifeCheck, laterCheck, localCheck, referencedCheck } from "./patterns";

const NOISE = [AUTOMATED];
const REFERENCED = referencedCheck;
const DIRECT = directCheck("noreply@example.com");
const IIFE = (() => iifeCheck("noreply@example.com"))();
const CALLBACK = NOISE.map((pattern) => callbackCheck(pattern));

function checkedWhileLoading() {
  return localCheck("noreply@example.com");
}

const LOCAL = checkedWhileLoading();

function checkedLater() {
  return laterCheck("noreply@example.com");
}

export function describeSender(address: string): string {
  return NOISE.some((pattern) => new RegExp(pattern).test(address)) || DIRECT || IIFE || LOCAL || CALLBACK.length > 0 ? "automated" : address;
}

export function laterRead() {
  return REFERENCED("noreply@example.com") && checkedLater();
}
