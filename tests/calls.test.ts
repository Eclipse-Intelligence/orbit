import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { listActivities } from "@/lib/crm/activities";
import {
  callBody,
  callTitle,
  formatCallDuration,
  getCallSync,
  syncCalls,
} from "@/lib/crm/calls";
import { createCompany } from "@/lib/crm/companies";
import { createContact, updateContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import {
  CALL_PERMISSION_MESSAGE,
  sanitizeCallError,
  type PstnCallRow,
} from "@/lib/microsoft/calls";
import { createUser, resetDatabase } from "./helpers";

before(async () => {
  await resetDatabase();
  process.env.MICROSOFT_CLIENT_ID = "test-client";
  process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
  delete process.env.MICROSOFT_TENANT;
});

after(async () => {
  await getPool().end();
});

function fakeJwt(claims: Record<string, string>) {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.signature`;
}

async function connect(
  owner: UserActor,
  email: string,
  claims: Record<string, string>,
) {
  await saveMailbox(owner, {
    email,
    refreshToken: "stored-refresh",
    accessToken: fakeJwt(claims),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
}

function graph(rows: () => PstnCallRow[]) {
  const requests: { url: string; body: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: String(init?.body ?? "") });
    if (url.includes("/oauth2/v2.0/token")) {
      return Response.json({ access_token: "app-token", expires_in: 3600 });
    }
    return Response.json({ value: rows() });
  };
  return { fetchImpl, requests };
}

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

describe("teams calls", () => {
  it("formats call titles, bodies, and durations", () => {
    assert.equal(formatCallDuration(252), "4 min 12 s");
    assert.equal(formatCallDuration(42), "42 s");
    assert.equal(formatCallDuration(0), "0 s");
    assert.equal(formatCallDuration(3720), "1 h 2 min");
    assert.equal(callTitle("outbound", "Jane Doe"), "Call with Jane Doe");
    assert.equal(callTitle("inbound", "Jane Doe"), "Call from Jane Doe");
    assert.equal(callBody("outbound", 252), "Outgoing call · 4 min 12 s");
    assert.equal(callBody("inbound", 61), "Incoming call · 1 min 1 s");
  });

  it("logs outbound and inbound calls on contacts across UK number formats", async () => {
    const owner = await createUser("calls-owner@example.com", "Calls Owner");
    const company = await createCompany(owner, {
      name: "Harbor Calls",
      domain: "harbor-calls.test",
    });
    const jane = await createContact(owner, {
      companyId: company.body.company.id,
      firstName: "Jane",
      lastName: "Doe",
      phone: "07700 900123",
    });
    const raj = await createContact(owner, {
      firstName: "Raj",
      lastName: "Patel",
      phone: "+44 (0)20 7946 0000",
    });
    const una = await createContact(owner, {
      firstName: "Una",
      phone: "0044 161 496 0000",
    });
    await connect(owner, "Owner@Calls.test", {
      tid: "tenant-calls",
      oid: "user-object-1",
    });
    const started = minutesAgo(90);
    const { fetchImpl, requests } = graph(() => [
      {
        id: "row-out",
        userPrincipalName: "owner@calls.test",
        callType: "user_out",
        callerNumber: "+441234567890",
        calleeNumber: "+447700900123",
        startDateTime: started,
        duration: 252,
      },
      {
        id: "row-in",
        userId: "USER-OBJECT-1",
        userPrincipalName: "alias@calls.test",
        callType: "user_in",
        callerNumber: "+442079460000",
        calleeNumber: "+441234567890",
        startDateTime: minutesAgo(60),
        duration: 42,
      },
      {
        id: "row-una",
        userPrincipalName: "OWNER@calls.test",
        callType: "user_out",
        calleeNumber: "+441614960000",
        startDateTime: minutesAgo(30),
        duration: 60,
      },
      {
        id: "row-conference",
        userPrincipalName: "owner@calls.test",
        callType: "user_out_conf",
        calleeNumber: "+447700900123",
        startDateTime: minutesAgo(20),
        duration: 300,
      },
      {
        id: "row-someone-else",
        userPrincipalName: "colleague@calls.test",
        userId: "user-object-2",
        callType: "user_out",
        calleeNumber: "+447700900123",
        startDateTime: minutesAgo(10),
        duration: 30,
      },
    ]);

    const result = await syncCalls(owner, { fetchImpl });
    assert.equal(result.error, undefined);
    assert.equal(result.ran, true);
    assert.equal(result.logged, 3);
    assert.equal(result.unmatched, 0);
    assert.equal(result.skipped, 2);

    const token = requests.find((request) => request.url.includes("/token"));
    assert.equal(
      token?.url,
      "https://login.microsoftonline.com/tenant-calls/oauth2/v2.0/token",
    );
    assert.match(token?.body ?? "", /grant_type=client_credentials/);
    assert.match(
      token?.body ?? "",
      /scope=https%3A%2F%2Fgraph\.microsoft\.com%2F\.default/,
    );
    const call = requests.find((request) =>
      request.url.includes("getPstnCalls"),
    );
    assert.match(
      call?.url ?? "",
      /\/communications\/callRecords\/getPstnCalls\(fromDateTime=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ,toDateTime=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\)$/,
    );

    const janeCalls = await listActivities(owner, {
      contactId: jane.body.contact.id,
    });
    assert.equal(janeCalls.total, 1);
    const outgoing = janeCalls.data[0]!;
    assert.equal(outgoing.type, "call");
    assert.equal(outgoing.title, "Call with Jane Doe");
    assert.equal(outgoing.body, "Outgoing call · 4 min 12 s");
    assert.equal(outgoing.occurredAt, started);
    assert.equal(outgoing.companyId, company.body.company.id);

    const rajCalls = await listActivities(owner, {
      contactId: raj.body.contact.id,
    });
    assert.equal(rajCalls.data[0]?.title, "Call from Raj Patel");
    assert.equal(rajCalls.data[0]?.body, "Incoming call · 42 s");

    const unaCalls = await listActivities(owner, {
      contactId: una.body.contact.id,
    });
    assert.equal(unaCalls.data[0]?.title, "Call with Una");

    const audit = await getAdminPool().query<{ total: number }>(
      `select count(*)::int as total from crm.audit_events
       where workspace_id = $1 and event_type = 'activity.created' and operation = 'sync_calls'`,
      [owner.workspaceId],
    );
    assert.equal(audit.rows[0]?.total, 3);

    const summary = await getCallSync(owner);
    assert.equal(summary?.logged, 3);
    assert.equal(summary?.unmatched, 0);
    assert.equal(summary?.lastError, null);
    assert.ok(summary?.lastSyncedAt);
    const state = await getAdminPool().query<{ tenant_id: string }>(
      `select tenant_id from crm.call_sync_state where workspace_id = $1`,
      [owner.workspaceId],
    );
    assert.equal(state.rows[0]?.tenant_id, "tenant-calls");
  });

  it("does not log a call twice when the overlap window returns it again", async () => {
    const owner = await createUser("calls-dedupe@example.com", "Calls Dedupe");
    const contact = await createContact(owner, {
      firstName: "Dee",
      phone: "+447700900456",
    });
    await connect(owner, "owner@dedupe.test", { tid: "tenant-dedupe" });
    const rows: PstnCallRow[] = [
      {
        id: "dedupe-1",
        userPrincipalName: "owner@dedupe.test",
        callType: "user_out",
        calleeNumber: "07700900456",
        startDateTime: minutesAgo(15),
        duration: 75,
      },
    ];
    const { fetchImpl, requests } = graph(() => rows);
    const first = await syncCalls(owner, { fetchImpl });
    assert.equal(first.logged, 1);
    const synced = (await getCallSync(owner))!.lastSyncedAt!;

    const second = await syncCalls(owner, { force: true, fetchImpl });
    assert.equal(second.error, undefined);
    assert.equal(second.logged, 0);
    assert.equal(second.skipped, 1);
    const activities = await listActivities(owner, {
      contactId: contact.body.contact.id,
    });
    assert.equal(activities.total, 1);

    const urls = requests
      .map((request) => request.url)
      .filter((url) => url.includes("getPstnCalls"));
    assert.equal(urls.length, 2);
    const from = urls[1]!.match(/fromDateTime=([^,]+),/)?.[1];
    assert.equal(
      new Date(from!).getTime(),
      Math.floor((new Date(synced).getTime() - 24 * 60 * 60 * 1000) / 1000) *
        1000,
    );
  });

  it("files an unknown number and logs it once a contact gets that phone", async () => {
    const owner = await createUser("calls-later@example.com", "Calls Later");
    const contact = await createContact(owner, {
      firstName: "Lee",
      lastName: "Later",
      email: "lee@later-calls.test",
    });
    await connect(owner, "owner@later-calls.test", { tid: "tenant-later" });
    const { fetchImpl } = graph(() => [
      {
        id: "later-1",
        userPrincipalName: "owner@later-calls.test",
        callType: "user_in",
        callerNumber: "+447700900789",
        startDateTime: minutesAgo(45),
        duration: 125,
      },
    ]);
    const first = await syncCalls(owner, { fetchImpl });
    assert.equal(first.logged, 0);
    assert.equal(first.unmatched, 1);
    assert.equal((await getCallSync(owner))?.unmatched, 1);

    await updateContact(owner, contact.body.contact.id, {
      phone: "07700 900789",
    });
    const second = await syncCalls(owner, { force: true, fetchImpl });
    assert.equal(second.logged, 1);
    const activities = await listActivities(owner, {
      contactId: contact.body.contact.id,
      type: "call",
    });
    assert.equal(activities.total, 1);
    assert.equal(activities.data[0]?.title, "Call from Lee Later");
    assert.equal(activities.data[0]?.body, "Incoming call · 2 min 5 s");
    const summary = await getCallSync(owner);
    assert.equal(summary?.logged, 1);
    assert.equal(summary?.unmatched, 0);

    const third = await syncCalls(owner, { force: true, fetchImpl });
    assert.equal(third.logged, 0);
    assert.equal(
      (
        await listActivities(owner, {
          contactId: contact.body.contact.id,
          type: "call",
        })
      ).total,
      1,
    );
  });

  it("explains the missing CallRecords.Read.All permission", async () => {
    const owner = await createUser("calls-denied@example.com", "Calls Denied");
    await connect(owner, "owner@denied-calls.test", { tid: "tenant-denied" });
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("/token")) {
        return Response.json({ access_token: "app-token", expires_in: 3600 });
      }
      return Response.json(
        {
          error: {
            code: "Authorization_RequestDenied",
            message: "Insufficient privileges to complete the operation.",
          },
        },
        { status: 403 },
      );
    };
    const result = await syncCalls(owner, { fetchImpl });
    assert.equal(result.error, CALL_PERMISSION_MESSAGE);
    assert.equal(
      result.error,
      "Grant Orbit the CallRecords.Read.All application permission with admin consent in Microsoft Entra.",
    );
    const summary = await getCallSync(owner);
    assert.equal(summary?.lastError, CALL_PERMISSION_MESSAGE);
    assert.equal(summary?.lastSyncedAt, null);
    assert.equal(
      sanitizeCallError(
        "AADSTS65001: The user or administrator has not consented to use the application.",
      ),
      CALL_PERMISSION_MESSAGE,
    );
  });

  it("waits five minutes between automatic syncs unless forced", async () => {
    const owner = await createUser("calls-gate@example.com", "Calls Gate");
    await connect(owner, "owner@gate-calls.test", { tid: "tenant-gate" });
    let graphCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("/token")) {
        return Response.json({ access_token: "app-token", expires_in: 3600 });
      }
      graphCalls += 1;
      return Response.json({ value: [] });
    };
    const first = await syncCalls(owner, { fetchImpl });
    assert.equal(first.ran, true);
    assert.equal(graphCalls, 1);

    const gated = await syncCalls(owner, { fetchImpl });
    assert.equal(gated.ran, false);
    assert.equal(gated.error, undefined);
    assert.equal(graphCalls, 1);

    const forced = await syncCalls(owner, { force: true, fetchImpl });
    assert.equal(forced.ran, true);
    assert.equal(graphCalls, 2);

    await getAdminPool().query(
      `update crm.call_sync_state
       set last_attempt_at = now() - interval '6 minutes'
       where workspace_id = $1`,
      [owner.workspaceId],
    );
    const due = await syncCalls(owner, { fetchImpl });
    assert.equal(due.ran, true);
    assert.equal(graphCalls, 3);
  });

  it("finds the tenant from MICROSOFT_TENANT or a refreshed mailbox token", async () => {
    const owner = await createUser("calls-tenant@example.com", "Calls Tenant");
    await saveMailbox(owner, {
      email: "owner@tenant-calls.test",
      refreshToken: "stored-refresh",
      accessToken: "opaque-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (String(init?.body ?? "").includes("grant_type=refresh_token")) {
        return Response.json({
          access_token: fakeJwt({ tid: "tenant-refreshed" }),
          refresh_token: "new-refresh",
          expires_in: 3600,
        });
      }
      if (url.includes("/token")) {
        return Response.json({ access_token: "app-token", expires_in: 3600 });
      }
      return Response.json({ value: [] });
    };
    const first = await syncCalls(owner, { fetchImpl });
    assert.equal(first.error, undefined);
    assert.ok(
      urls.includes(
        "https://login.microsoftonline.com/tenant-refreshed/oauth2/v2.0/token",
      ),
    );

    process.env.MICROSOFT_TENANT = "contoso.onmicrosoft.com";
    try {
      urls.length = 0;
      const second = await syncCalls(owner, { force: true, fetchImpl });
      assert.equal(second.error, undefined);
      assert.ok(
        urls.includes(
          "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token",
        ),
      );
    } finally {
      delete process.env.MICROSOFT_TENANT;
    }
  });

  it("asks for a connected mailbox before syncing calls", async () => {
    const owner = await createUser("calls-none@example.com", "Calls None");
    const result = await syncCalls(owner, {
      fetchImpl: async () => {
        throw new Error("should not call Microsoft");
      },
    });
    assert.equal(result.ran, false);
    assert.match(result.error ?? "", /Connect Microsoft/);
    assert.equal(await getCallSync(owner), null);
  });
});
