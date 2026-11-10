import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { CrmError } from "@/lib/crm/errors";
import { createWebhook, deliverDueWebhooks, privateWebhookTargetsAllowed } from "@/lib/crm/webhooks";
import { createUser, resetDatabase } from "./helpers";

const PUBLIC = "93.184.215.14";

before(async () => {
  await resetDatabase();
  delete process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS;
});

after(async () => {
  await getPool().end();
});

function resolver(map: Record<string, string[]>) {
  return async (hostname: string) => {
    const found = map[hostname];
    if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return found;
  };
}

async function queueDelivery(workspaceId: string, url: string) {
  const admin = getAdminPool();
  const endpoint = await admin.query<{ id: string }>(
    `insert into crm.webhook_endpoints (workspace_id, url, secret, events)
     values ($1, $2, 'secret', array['*']) returning id`,
    [workspaceId, url],
  );
  const delivery = await admin.query<{ id: string }>(
    `insert into crm.webhook_deliveries (workspace_id, endpoint_id, event_id, event_type, payload)
     values ($1, $2, $3, 'company.created', '{}'::jsonb) returning id`,
    [workspaceId, endpoint.rows[0].id, randomUUID()],
  );
  return delivery.rows[0].id;
}

async function readDelivery(id: string) {
  const row = await getAdminPool().query<{ status: string; last_status_code: number | null; last_error: string | null }>(
    "select status, last_status_code, last_error from crm.webhook_deliveries where id = $1",
    [id],
  );
  return row.rows[0];
}

describe("webhook targets", () => {
  it("refuses private, local and metadata addresses when saving", async () => {
    const owner = await createUser("hook-targets@example.com", "Targets");
    const lookup = resolver({
      "inside.example": ["10.0.0.5"],
      "mixed.example": [PUBLIC, "192.168.1.4"],
      "mapped.example": ["::ffff:127.0.0.1"],
      "public.example": [PUBLIC, "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
    });
    const refused = [
      "http://127.0.0.1:8080/hook",
      "https://127.0.0.1/hook",
      "https://localhost/hook",
      "https://metadata.google.internal/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/hook",
      "https://224.0.0.1/hook",
      "https://0.0.0.0/hook",
      "https://[::1]/hook",
      "https://[::ffff:169.254.169.254]/hook",
      "https://[fd00::1]/hook",
      "https://[fe80::1]/hook",
      "https://inside.example/hook",
      "https://mixed.example/hook",
      "https://mapped.example/hook",
      "https://missing.example/hook",
    ];
    for (const url of refused) {
      await assert.rejects(
        createWebhook(owner, { url, events: ["*"] }, { lookup }),
        (error: unknown) => error instanceof CrmError && error.status === 400,
        url,
      );
    }
    const saved = await createWebhook(owner, { url: "https://public.example/hook", events: ["*"] }, { lookup });
    assert.equal(saved.endpoint.url, "https://public.example/hook");
  });

  it("allows private targets only through the flag and never in production", async () => {
    const env = process.env as Record<string, string | undefined>;
    const original = env.NODE_ENV;
    try {
      env.WEBHOOKS_ALLOW_PRIVATE_TARGETS = "1";
      env.NODE_ENV = "development";
      assert.equal(privateWebhookTargetsAllowed(), true);
      const owner = await createUser("hook-local@example.com", "Local");
      const saved = await createWebhook(owner, { url: "http://127.0.0.1:9/hook", events: ["*"] });
      assert.equal(saved.endpoint.url, "http://127.0.0.1:9/hook");
      env.NODE_ENV = "production";
      assert.equal(privateWebhookTargetsAllowed(), false);
    } finally {
      if (original === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = original;
      delete env.WEBHOOKS_ALLOW_PRIVATE_TARGETS;
    }
  });

  it("checks the address again when delivering and fails a host that now points inside", async () => {
    const owner = await createUser("hook-rebind@example.com", "Rebind");
    const id = await queueDelivery(owner.workspaceId, "https://rebind.example/hook");
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return new Response("ok");
    }) as typeof fetch;
    await deliverDueWebhooks(20, { lookup: resolver({ "rebind.example": ["169.254.169.254"] }), fetchImpl });
    assert.equal(called, 0);
    const row = await readDelivery(id);
    assert.equal(row.status, "failed");
    assert.match(row.last_error ?? "", /isn't a public address/);
  });

  it("retries later when the address can't be looked up just now", async () => {
    const owner = await createUser("hook-dns@example.com", "Dns");
    const id = await queueDelivery(owner.workspaceId, "https://flaky.example/hook");
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return new Response("ok");
    }) as typeof fetch;
    const lookup = async (): Promise<string[]> => {
      throw Object.assign(new Error("getaddrinfo EAI_AGAIN flaky.example"), { code: "EAI_AGAIN" });
    };
    await deliverDueWebhooks(20, { lookup, fetchImpl });
    assert.equal(called, 0);
    const row = await readDelivery(id);
    assert.equal(row.status, "pending");
    assert.match(row.last_error ?? "", /Couldn't look up flaky\.example/);
    await assert.rejects(
      createWebhook(owner, { url: "https://flaky.example/hook", events: ["*"] }, { lookup }),
      (error: unknown) => error instanceof CrmError && error.status === 400 && /Couldn't look up flaky\.example\. Try again\./.test(error.message),
    );
  });

  it("fails a delivery for good when the host doesn't exist", async () => {
    const owner = await createUser("hook-gone@example.com", "Gone");
    const id = await queueDelivery(owner.workspaceId, "https://gone.example/hook");
    await deliverDueWebhooks(20, { lookup: resolver({}), fetchImpl: (async () => new Response("ok")) as typeof fetch });
    const row = await readDelivery(id);
    assert.equal(row.status, "failed");
    assert.match(row.last_error ?? "", /not found\. Check the URL/);
  });

  it("does not follow redirects and records a redirect as a failed attempt", async () => {
    const owner = await createUser("hook-redirect@example.com", "Redirect");
    const id = await queueDelivery(owner.workspaceId, "https://redirect.example/hook");
    const seen: (RequestRedirect | undefined)[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.redirect);
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    }) as typeof fetch;
    await deliverDueWebhooks(20, { lookup: resolver({ "redirect.example": [PUBLIC] }), fetchImpl });
    assert.deepEqual(seen, ["manual"]);
    const row = await readDelivery(id);
    assert.equal(row.status, "pending");
    assert.equal(row.last_status_code, 302);
    assert.match(row.last_error ?? "", /Redirected/);
  });

  it("delivers to a public host", async () => {
    const owner = await createUser("hook-public@example.com", "Public");
    const id = await queueDelivery(owner.workspaceId, "https://ok.example/hook");
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    await deliverDueWebhooks(20, { lookup: resolver({ "ok.example": [PUBLIC] }), fetchImpl });
    assert.equal((await readDelivery(id)).status, "delivered");
  });
});
