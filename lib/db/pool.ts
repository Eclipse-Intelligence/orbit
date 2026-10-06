import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

const globalPools = globalThis as typeof globalThis & {
  __crmPool?: Pool;
  __crmAdminPool?: Pool;
};

function createPool(connectionString: string) {
  const url = new URL(connectionString);
  const options = url.searchParams.get("options") ?? "";
  if (!options.includes("statement_timeout")) {
    url.searchParams.set("options", `${options} -c statement_timeout=10000`.trim());
  }
  if (url.searchParams.get("sslmode") === "require" && !url.searchParams.has("uselibpqcompat")) {
    url.searchParams.set("uselibpqcompat", "true");
  }
  return new Pool({
    connectionString: url.toString(),
    max: 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
}

export function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

export function getPool() {
  if (!globalPools.__crmPool || globalPools.__crmPool.ending || globalPools.__crmPool.ended) {
    globalPools.__crmPool = createPool(databaseUrl());
  }
  return globalPools.__crmPool;
}

export function getAdminPool() {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL is not set");
  if (!globalPools.__crmAdminPool || globalPools.__crmAdminPool.ending || globalPools.__crmAdminPool.ended) {
    globalPools.__crmAdminPool = createPool(url);
  }
  return globalPools.__crmAdminPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, values);
}

export type Db = PoolClient;
