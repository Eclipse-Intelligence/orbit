import { z } from "zod";

type Schema = Record<string, unknown>;

function asSchema(value: unknown): Schema {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Schema) : {};
}

function enumOf(values: unknown[]): z.ZodType {
  if (values.length > 0 && values.every((value) => typeof value === "string")) return z.enum(values as [string, ...string[]]);
  const literals = values.filter((value): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value)).map((value) => z.literal(value));
  if (literals.length === 0) return z.unknown();
  if (literals.length === 1) return literals[0];
  return z.union(literals as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

function zodFor(input: unknown): z.ZodType {
  const schema = asSchema(input);
  let out: z.ZodType;
  if (Array.isArray(schema.enum)) {
    out = enumOf(schema.enum);
  } else if (schema.type === "string") {
    out = z.string();
  } else if (schema.type === "integer" || schema.type === "number") {
    let number = schema.type === "integer" ? z.number().int() : z.number();
    if (typeof schema.minimum === "number") number = number.min(schema.minimum);
    if (typeof schema.maximum === "number") number = number.max(schema.maximum);
    out = number;
  } else if (schema.type === "boolean") {
    out = z.boolean();
  } else if (schema.type === "array") {
    out = z.array(schema.items ? zodFor(schema.items) : z.unknown());
  } else if (schema.type === "object") {
    const shape = shapeFor(schema);
    out = Object.keys(shape).length === 0 ? z.record(z.string(), z.unknown()) : z.looseObject(shape);
  } else {
    out = z.unknown();
  }
  return typeof schema.description === "string" ? out.describe(schema.description) : out;
}

function allowsNull(input: unknown) {
  const description = asSchema(input).description;
  return typeof description === "string" && /\bnull\b/i.test(description);
}

function optional(input: unknown) {
  return allowsNull(input) ? zodFor(input).nullable().optional() : zodFor(input).optional();
}

export function shapeFor(input: unknown): Record<string, z.ZodType> {
  const schema = asSchema(input);
  const properties = asSchema(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : []);
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, required.has(key) ? zodFor(value) : optional(value)]),
  );
}
