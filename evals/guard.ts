import { parse } from "pg-connection-string";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const OVERRIDES = ["host", "hostaddr", "port"];

export function evalDatabase(raw: string, label: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} isn't a database URL.`);
  }
  const overridden = OVERRIDES.filter((key) => [...url.searchParams.keys()].some((name) => name.toLowerCase() === key));
  if (overridden.length > 0) throw new Error(`${label} sets ${overridden.join(" and ")} in its query string. Evaluations wipe their database, so put the host and port in the URL itself.`);
  const parsed = parse(raw) as { host?: string | null; hostaddr?: string | null; port?: string | null; database?: string | null };
  const host = (parsed.host ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOCAL_HOSTS.has(host)) throw new Error(`${label} points at ${host || "no host"}. Evaluations wipe their database, so they only run against a local one.`);
  if (parsed.hostaddr && !LOCAL_HOSTS.has(parsed.hostaddr)) throw new Error(`${label} connects to ${parsed.hostaddr}. Evaluations only run against a local database.`);
  const name = parsed.database ?? "";
  if (!(name === "crm_eval" || name.startsWith("crm_eval_") || name.startsWith("crm_test_"))) {
    throw new Error(`${label} uses the database ${name || "(none)"}. Evaluations wipe their database, so it must be crm_eval or start with crm_eval_ or crm_test_.`);
  }
  return { url, name };
}
