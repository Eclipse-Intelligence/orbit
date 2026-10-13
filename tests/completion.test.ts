import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { toCsv } from "@/lib/csv";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createCompany, getCompany } from "@/lib/crm/companies";
import { recordCommunication } from "@/lib/crm/communications";
import { createContact, getContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { archiveOpportunity, createOpportunity, getOpportunity, listPipeline } from "@/lib/crm/opportunities";
import { savePipelineStages } from "@/lib/crm/pipeline";
import { getCompanyContext } from "@/lib/crm/relationships";
import { importCompaniesCsv, importContactsCsv, parseCsv } from "@/lib/crm/spreadsheet";
import { createTask, listTasks } from "@/lib/crm/tasks";
import { archiveWebhook, createWebhook, deliverDueWebhooks } from "@/lib/crm/webhooks";
import { createAgent, createUser, resetDatabase } from "./helpers";

before(async () => {
  await resetDatabase();
});

after(async () => {
  await getPool().end();
});

describe("imports, pipeline, communications, and webhooks", () => {
  it("parses quoted csv and imports a company once", async () => {
    const rows = parseCsv('Company,Domain\n"Harbor, Inc",harbor-import.example\n');
    assert.equal(rows[1][0], "Harbor, Inc");
    const owner = await createUser("import@example.com", "Importer");
    const first = await importCompaniesCsv(
      owner,
      "Company,Domain,Industry\nHarbor Import,harbor-import.example,Analytics\n",
    );
    assert.equal(first.created, 1);
    const second = await importCompaniesCsv(
      owner,
      "Company,Domain,Industry\nHarbor Import,harbor-import.example,Research\n",
    );
    assert.equal(second.created, 0);
    assert.equal(second.updated, 1);
  });

  it("leaves columns out of a csv import unchanged", async () => {
    const owner = await createUser("partial-import@example.com", "Partial");
    const company = await createCompany(owner, {
      name: "Partial Co",
      domain: "partial.example",
      website: "https://partial.example",
      industry: "Analytics",
    });
    const imported = await importCompaniesCsv(
      owner,
      "Company,Domain,Industry\nPartial Co,partial.example,Research\n",
    );
    assert.equal(imported.updated, 1);
    const saved = await getCompany(owner, company.body.company.id);
    assert.equal(saved.website, "https://partial.example/");
    assert.equal(saved.industry, "Research");
    const person = await createContact(owner, {
      companyId: company.body.company.id,
      firstName: "Ada",
      email: "ada@partial.example",
      phone: "+15551212",
    });
    const contacts = await importContactsCsv(owner, "Email,Title\nada@partial.example,Founder\n");
    assert.equal(contacts.updated, 1);
    const contact = await getContact(owner, person.body.contact.id);
    assert.equal(contact.firstName, "Ada");
    assert.equal(contact.phone, "+15551212");
    assert.equal(contact.jobTitle, "Founder");
    assert.equal(contact.companyId, company.body.company.id);
  });

  it("round-trips guarded csv cells and keeps blank cells from clearing data", async () => {
    assert.deepEqual(parseCsv('Name,Company\nAda, "Big, Co"\n')[1], ["Ada", "Big, Co"]);
    assert.equal(toCsv([["+44 20 7946 0958", "-12.5", "=SUM(A1)", "@cmd"]]), "+44 20 7946 0958,-12.5,'=SUM(A1),'@cmd");
    const owner = await createUser("csv-guard@example.com", "Guard");
    const person = await createContact(owner, {
      firstName: "Lin",
      email: "lin@guard.example",
      phone: "+441234567890",
      jobTitle: "CTO",
    });
    const result = await importContactsCsv(
      owner,
      "Email,Title,Notes\nlin@guard.example,,'=not a formula\n",
    );
    assert.equal(result.errors.length, 0);
    const contact = await getContact(owner, person.body.contact.id);
    assert.equal(contact.jobTitle, "CTO");
    assert.equal(contact.phone, "+441234567890");
    assert.equal(contact.notes, "=not a formula");
    const { actor: reader } = await createAgent(owner.workspaceId, ["crm:read"]);
    await assert.rejects(
      () => importContactsCsv(reader, "Email\nnobody@guard.example\n"),
      (error: unknown) => error instanceof CrmError && error.status === 403,
    );
  });

  it("reports company import errors against the source row", async () => {
    const owner = await createUser("csv-rows@example.com", "Rows");
    const result = await importCompaniesCsv(
      owner,
      `Company,Domain,Industry\n,,Analytics\n${"x".repeat(300)},,Research\nRow Four,rowfour.example,Retail\n`,
    );
    assert.equal(result.created, 1);
    assert.deepEqual(
      result.errors.map((error) => error.row),
      [2, 3],
    );
  });

  it("renames a pipeline stage without dropping won and lost", async () => {
    const owner = await createUser("pipeline@example.com", "Pipeline");
    const current = await listPipeline(owner);
    const stages = await savePipelineStages(
      owner,
      current.stages.map((stage) => ({
        id: stage.id,
        name: stage.name === "New" ? "Intro" : stage.name,
        probability: stage.probability,
        isWon: stage.isWon,
        isLost: stage.isLost,
      })),
    );
    assert.equal(stages.some((stage) => stage.name === "Intro"), true);
    assert.equal(stages.filter((stage) => stage.isWon).length, 1);
    assert.equal(stages.filter((stage) => stage.isLost).length, 1);
    const removed = await savePipelineStages(
      owner,
      stages
        .filter((stage) => stage.name !== "Working")
        .map((stage) => ({
          id: stage.id,
          name: stage.name,
          probability: stage.probability,
          isWon: stage.isWon,
          isLost: stage.isLost,
        })),
    );
    assert.equal(removed.some((stage) => stage.name === "Working"), false);
  });

  it("moves archived deals off a removed stage and resyncs status when won changes", async () => {
    const owner = await createUser("pipeline-sync@example.com", "Sync");
    const company = await createCompany(owner, { name: "Sync Co", domain: "sync.example" });
    const current = await listPipeline(owner);
    const working = current.stages.find((stage) => stage.name === "Working")!;
    const proposal = current.stages.find((stage) => stage.name === "Proposal")!;
    const parked = await createOpportunity(owner, {
      companyId: company.body.company.id,
      name: "Parked deal",
      stageId: working.id,
    });
    await archiveOpportunity(owner, parked.body.opportunity.id);
    const live = await createOpportunity(owner, {
      companyId: company.body.company.id,
      name: "Live deal",
      stageId: proposal.id,
    });
    assert.equal(live.body.opportunity.probability, proposal.probability);
    const saved = await savePipelineStages(
      owner,
      current.stages
        .filter((stage) => stage.id !== working.id)
        .map((stage) => ({
          id: stage.id,
          name: stage.name,
          probability: stage.probability,
          isWon: stage.id === proposal.id,
          isLost: stage.isLost,
        })),
    );
    assert.equal(saved.some((stage) => stage.id === working.id), false);
    const admin = getAdminPool();
    const moved = await admin.query<{ stage_id: string; status: string }>(
      "select stage_id, status from crm.opportunities where id = $1",
      [parked.body.opportunity.id],
    );
    const firstOpen = saved.find((stage) => !stage.isWon && !stage.isLost)!;
    assert.equal(moved.rows[0].stage_id, firstOpen.id);
    assert.equal(moved.rows[0].status, "open");
    const won = await getOpportunity(owner, live.body.opportunity.id);
    assert.equal(won.status, "won");
    const blocked = await createOpportunity(owner, {
      companyId: company.body.company.id,
      name: "Blocking deal",
      stageId: saved.find((stage) => stage.name === "New")!.id,
    });
    assert.ok(blocked.body.opportunity.id);
    await assert.rejects(
      () =>
        savePipelineStages(
          owner,
          saved
            .filter((stage) => stage.name !== "New")
            .map((stage) => ({ ...stage })),
        ),
      /Move opportunities off a stage/,
    );
  });

  it("keeps an archived won deal won when its stage is replaced", async () => {
    const owner = await createUser("pipeline-won@example.com", "Won");
    const company = await createCompany(owner, { name: "Won Co", domain: "won.example" });
    const current = await listPipeline(owner);
    const wonStage = current.stages.find((stage) => stage.isWon)!;
    const deal = await createOpportunity(owner, {
      companyId: company.body.company.id,
      name: "Closed deal",
      stageId: wonStage.id,
    });
    await archiveOpportunity(owner, deal.body.opportunity.id);
    const saved = await savePipelineStages(owner, [
      ...current.stages
        .filter((stage) => stage.id !== wonStage.id)
        .map((stage) => ({
          id: stage.id,
          name: stage.name,
          probability: stage.probability,
          isWon: false,
          isLost: stage.isLost,
        })),
      { name: "Closed won", probability: 100, isWon: true, isLost: false },
    ]);
    const replacement = saved.find((stage) => stage.isWon)!;
    const moved = await getAdminPool().query<{ stage_id: string; status: string }>(
      "select stage_id, status from crm.opportunities where id = $1",
      [deal.body.opportunity.id],
    );
    assert.equal(moved.rows[0].stage_id, replacement.id);
    assert.equal(moved.rows[0].status, "won");
  });

  it("orders next actions by due date then high, normal, low priority", async () => {
    const owner = await createUser("priority@example.com", "Priority");
    const dueAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    for (const priority of ["low", "high", "normal"] as const) {
      await createTask(owner, { title: `Priority ${priority}`, dueAt, priority });
    }
    const listed = await listTasks(owner, { view: "upcoming" });
    assert.deepEqual(
      listed.data.map((task) => task.priority),
      ["high", "normal", "low"],
    );
  });

  it("files an email on the company domain and suggests a follow-up", async () => {
    const owner = await createUser("mail@example.com", "Mail");
    const company = await createCompany(owner, { name: "Mail Co", domain: "mailco.example" });
    await createContact(owner, {
      companyId: company.body.company.id,
      firstName: "Grace",
      email: "grace@mailco.example",
    });
    const filed = await recordCommunication(owner, {
      kind: "email",
      title: "Pricing",
      body: "Asked about the pilot",
      participantEmails: ["Grace@mailco.example"],
    });
    assert.equal(filed.activity.type, "email");
    assert.equal(filed.company?.id, company.body.company.id);
    assert.equal(filed.contacts[0]?.email, "grace@mailco.example");
    assert.equal(filed.suggested, true);
    assert.match(filed.task?.title ?? "", /Follow up with Grace/);
    const again = await recordCommunication(owner, {
      kind: "meeting",
      title: "Intro",
      body: "Walked through the product",
      companyId: company.body.company.id,
    });
    assert.equal(again.suggested, false);
    const context = await getCompanyContext(owner, company.body.company.id);
    assert.equal(context.relationshipStatus, "active");
  });

  it("signs a webhook and retries a failed delivery", async () => {
    const owner = await createUser("hooks@example.com", "Hooks");
    const hits: { signature: string | null; timestamp: string | null; body: string; event: string | null }[] = [];
    let failOnce = true;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        hits.push({
          signature: request.headers["x-crm-signature"]?.toString() ?? null,
          timestamp: request.headers["x-crm-timestamp"]?.toString() ?? null,
          body,
          event: request.headers["x-crm-event"]?.toString() ?? null,
        });
        if (failOnce) {
          failOnce = false;
          response.writeHead(500);
          response.end("no");
          return;
        }
        response.writeHead(200);
        response.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      const created = await createWebhook(owner, {
        url: `http://127.0.0.1:${port}/hook`,
        events: ["company.created"],
      });
      await createCompany(owner, { name: "Hook Co", domain: "hookco.example" });
      for (let attempt = 0; attempt < 10 && hits.length === 0; attempt += 1) {
        await deliverDueWebhooks();
      }
      assert.equal(hits.length, 1);
      assert.equal(hits[0].event, "company.created");
      const payload = JSON.parse(hits[0].body) as { id: string; type: string };
      assert.equal(payload.type, "company.created");
      const expected = createHmac("sha256", created.secret)
        .update(`${hits[0].timestamp}.${hits[0].body}`)
        .digest("hex");
      assert.equal(hits[0].signature, `v1=${expected}`);
      const admin = getAdminPool();
      let recorded = false;
      for (let attempt = 0; attempt < 20 && !recorded; attempt += 1) {
        const row = await admin.query<{ last_error: string | null }>(
          "select last_error from crm.webhook_deliveries where event_id = $1",
          [payload.id],
        );
        recorded = Boolean(row.rows[0]?.last_error);
        if (!recorded) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(recorded, true);
      await admin.query(
        "update crm.webhook_deliveries set next_attempt_at = now(), status = 'pending' where event_id = $1",
        [payload.id],
      );
      await deliverDueWebhooks();
      assert.equal(hits.length, 2);
      await admin.query(
        "update crm.webhook_deliveries set next_attempt_at = now(), status = 'pending' where event_id = $1",
        [payload.id],
      );
      await archiveWebhook(owner, created.endpoint.id);
      await deliverDueWebhooks();
      assert.equal(hits.length, 2);
      await assert.rejects(
        () => archiveWebhook(owner, "not-a-uuid"),
        (error: unknown) => error instanceof CrmError && error.status === 404,
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
