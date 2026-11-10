import { londonDay, mergeFixtures } from "../world";
import { argText, mentions, type ArgTest } from "../checks";
import type { EvalTask, Fixture, When } from "../types";
import { BASE } from "./base";

export const PLAYBOOK_TOOLS = ["cold_email_playbook"];

export function task(definition: Omit<EvalTask, "fixture"> & { fixture?: Fixture }): EvalTask {
  return { ...definition, fixture: mergeFixtures(BASE, definition.fixture ?? {}) };
}

function addresses(value: unknown) {
  return new Set([...argText(value).toLowerCase().matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)].map((match) => match[0]));
}

function day(value: unknown) {
  const text = argText(value).trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const british = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (british) return `${british[3]}-${british[2].padStart(2, "0")}-${british[1].padStart(2, "0")}`;
  return null;
}

export function dueOn(key: string, ...whens: When[]): ArgTest {
  return (args) => whens.some((when) => day(args[key]) === londonDay(when));
}

export function startsAt(key: string, when: When, time: string): ArgTest {
  return (args) => day(args[key]) === londonDay(when) && new RegExp(`[T ]${time}`).test(argText(args[key]));
}

export function recipient(email: string, keys = ["to", "cc", "bcc"]): ArgTest {
  return (args) => keys.some((key) => addresses(args[key]).has(email.toLowerCase()));
}

export function toContact(name: string, email: string): ArgTest {
  return (args, world) =>
    args.contactId === world.id(`contact:${name}`) ||
    recipient(email, ["to"])(args, world) ||
    (typeof args.replyToEmailId === "string" && world.emailFrom.get(args.replyToEmailId) === email.toLowerCase());
}

export function bodyMentions(...needles: string[]): ArgTest {
  return (args) => needles.every((needle) => mentions(argText(args.body), needle));
}

export function bodyMatches(pattern: RegExp): ArgTest {
  return (args) => pattern.test(argText(args.body));
}

export function idsInclude(key: string, ...worldKeys: string[]): ArgTest {
  return (args, world) => worldKeys.every((worldKey) => argText(args[key]).includes(world.id(worldKey)));
}

export function idsExclude(key: string, ...worldKeys: string[]): ArgTest {
  return (args, world) => worldKeys.every((worldKey) => !argText(args[key]).includes(world.id(worldKey)));
}

export function touches(...worldKeys: string[]): ArgTest {
  return (args, world) => worldKeys.some((worldKey) => argText(args).includes(world.id(worldKey)));
}
