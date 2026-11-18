import {
  AUTOMATED,
  callbackCheck,
  classCheck,
  directCheck,
  iifeCheck,
  laterCheck,
  localCheck,
  methodCheck,
  passedCheck,
  referencedCheck,
} from "./patterns";

const NOISE = [AUTOMATED];
const REFERENCED = referencedCheck;
const DIRECT = directCheck("noreply@example.com");
const IIFE = (() => iifeCheck("noreply@example.com"))();
const CALLBACK = NOISE.map((pattern) => callbackCheck(pattern));
const PASSED = NOISE.filter(passedCheck);

function checkedWhileLoading() {
  return localCheck("noreply@example.com");
}

const LOCAL = checkedWhileLoading();

class Classifier {
  automated = classCheck("noreply@example.com");
}

const CLASSIFIED = new Classifier();

const rules = {
  run() {
    return methodCheck("noreply@example.com");
  },
};

const RULED = rules.run();

function checkedLater() {
  return laterCheck("noreply@example.com");
}

export function describeSender(address: string): string {
  const flags = [DIRECT, IIFE, LOCAL, CLASSIFIED.automated, RULED, CALLBACK.length > 0, PASSED.length > 0];
  return NOISE.some((pattern) => new RegExp(pattern).test(address)) || flags.some(Boolean) ? "automated" : address;
}

export function laterRead() {
  return REFERENCED("noreply@example.com") && checkedLater();
}
