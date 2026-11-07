import { londonDay, mergeFixtures } from "../world";
import { mentions, type ArgTest } from "../checks";
import type { EvalTask, Fixture, When } from "../types";
import { BASE } from "./base";

export const PLAYBOOK_TOOLS = ["cold_email_playbook"];

export const EMAIL_TOOLS = ["send_email", "save_email_draft"];

export function task(definition: Omit<EvalTask, "fixture"> & { fixture?: Fixture }): EvalTask {
  return { ...definition, fixture: mergeFixtures(BASE, definition.fixture ?? {}) };
}

function text(value: unknown) {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);
}

export function dueOn(key: string, ...whens: When[]): ArgTest {
  return (args) => whens.some((when) => text(args[key]).startsWith(londonDay(when)));
}

export function startsAt(key: string, when: When, time: string): ArgTest {
  return (args) => text(args[key]).startsWith(`${londonDay(when)}T${time}`);
}

export function recipient(email: string, keys = ["to", "cc", "bcc"]): ArgTest {
  return (args) => keys.some((key) => text(args[key]).toLowerCase().includes(email.toLowerCase()));
}

export function toContact(name: string, email: string): ArgTest {
  return (args, world) => args.contactId === world.id(`contact:${name}`) || recipient(email, ["to"])(args, world);
}

export function bodyMentions(...needles: string[]): ArgTest {
  return (args) => needles.every((needle) => mentions(text(args.body), needle));
}

export function bodyMatches(pattern: RegExp): ArgTest {
  return (args) => pattern.test(text(args.body));
}

export function idsInclude(key: string, ...worldKeys: string[]): ArgTest {
  return (args, world) => worldKeys.every((worldKey) => text(args[key]).includes(world.id(worldKey)));
}

export function idsExclude(key: string, ...worldKeys: string[]): ArgTest {
  return (args, world) => worldKeys.every((worldKey) => !text(args[key]).includes(world.id(worldKey)));
}

export function touches(...worldKeys: string[]): ArgTest {
  return (args, world) => worldKeys.some((worldKey) => text(args).includes(world.id(worldKey)));
}
