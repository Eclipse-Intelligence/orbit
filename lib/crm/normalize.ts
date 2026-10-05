import { CrmError } from "@/lib/crm/errors";
import { LIFECYCLES, type CompanyWrite, type Lifecycle } from "@/lib/crm/types";

const NAME_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "plc",
  "lp",
  "llp",
]);

export function normalizeCompanyName(name: string) {
  const stripped = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  const parts = stripped.split(" ").filter(Boolean);
  while (parts.length > 1 && NAME_SUFFIXES.has(parts[parts.length - 1])) {
    parts.pop();
  }
  return parts.join(" ");
}

export function canonicalDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/\.$/, "").replace(/^www\./, "");
  if (
    !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      host,
    )
  ) {
    return null;
  }
  return host;
}

export function canonicalWebsite(value: string): string | null {
  const domain = canonicalDomain(value);
  if (!domain) return null;
  const trimmed = value.trim();
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = domain;
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizePersonName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function canonicalEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (!email) return null;
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function canonicalLinkedin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/\.$/, "").replace(/^www\./, "").toLowerCase();
  if (host !== "linkedin.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0].toLowerCase() !== "in") return null;
  const slug = decodeURIComponent(parts[1]).toLowerCase();
  if (!/^[a-z0-9_-]{2,100}$/.test(slug)) return null;
  return `https://www.linkedin.com/in/${slug}`;
}

export function normalizedLinkedin(url: string) {
  return url.replace(/^https:\/\/www\./, "");
}

export function cleanText(value: string | null | undefined, max: number, field: string) {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new CrmError(
      "invalid_input",
      `${field} must be ${max} characters or fewer.`,
      400,
      { field },
    );
  }
  return trimmed;
}

export function normalizeCompanyWrite(
  input: CompanyWrite,
  mode: "create" | "patch" | "upsert",
): CompanyWrite & { normalizedName?: string } {
  const next: CompanyWrite & { normalizedName?: string } = {};

  if (input.name !== undefined) {
    const name = cleanText(input.name, 200, "name");
    if (!name) {
      throw new CrmError("invalid_input", "Enter a company name.", 400, {
        field: "name",
      });
    }
    const normalizedName = normalizeCompanyName(name);
    if (!normalizedName) {
      throw new CrmError("invalid_input", "Enter a company name.", 400, {
        field: "name",
      });
    }
    next.name = name;
    next.normalizedName = normalizedName;
  } else if (mode === "create") {
    throw new CrmError("invalid_input", "Enter a company name.", 400, {
      field: "name",
    });
  }

  if (input.domain !== undefined) {
    if (input.domain === null || input.domain.trim() === "") {
      next.domain = null;
    } else {
      const domain = canonicalDomain(input.domain);
      if (!domain) {
        throw new CrmError(
          "invalid_input",
          "Enter a domain like example.com.",
          400,
          { field: "domain" },
        );
      }
      next.domain = domain;
    }
  }

  if (input.website !== undefined) {
    if (input.website === null || input.website.trim() === "") {
      next.website = null;
    } else {
      const website = canonicalWebsite(input.website);
      if (!website) {
        throw new CrmError(
          "invalid_input",
          "Enter a website like https://example.com.",
          400,
          { field: "website" },
        );
      }
      next.website = website;
      if (next.domain === undefined && input.domain === undefined && mode !== "patch") {
        next.domain = canonicalDomain(website);
      }
    }
  }

  if (input.description !== undefined) {
    next.description = cleanText(input.description, 10000, "description");
  }
  if (input.industry !== undefined) {
    next.industry = cleanText(input.industry, 120, "industry");
  }
  if (input.sizeCategory !== undefined) {
    next.sizeCategory = cleanText(input.sizeCategory, 80, "sizeCategory");
  }
  if (input.source !== undefined) {
    next.source = cleanText(input.source, 120, "source");
  }
  if (input.sourceReference !== undefined) {
    next.sourceReference = cleanText(input.sourceReference, 500, "sourceReference");
  }
  if (input.lifecycle !== undefined) {
    if (!(LIFECYCLES as readonly string[]).includes(input.lifecycle)) {
      throw new CrmError("invalid_input", "Lifecycle is not recognised.", 400, {
        field: "lifecycle",
      });
    }
    next.lifecycle = input.lifecycle as Lifecycle;
  }
  if (input.ownerId !== undefined) {
    if (input.ownerId === null || input.ownerId === "") next.ownerId = null;
    else next.ownerId = input.ownerId;
  }

  if (mode === "upsert" && next.name === undefined && next.domain === undefined) {
    throw new CrmError(
      "invalid_input",
      "Provide a company name or domain.",
      400,
      { field: "name" },
    );
  }

  return next;
}

export function likePattern(query: string) {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
