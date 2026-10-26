import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { createOpportunity, listOpportunities, listPipeline } from "@/lib/crm/opportunities";
import { withActor } from "@/lib/crm/context";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createProduct, createTemplate, getTemplate, listProducts, updateProduct, updateTemplate } from "@/lib/proposals/catalogue";
import {
  countersignDocument,
  createDocument,
  documentFile,
  getDocument,
  listDocuments,
  reviseDocument,
  sendDocument,
  updateDocument,
} from "@/lib/proposals/documents";
import { fieldValues, renderBlocks, totalLabel, totalsOf } from "@/lib/proposals/model";
import { clientDecline, clientSign, openDocument, publicFile } from "@/lib/proposals/public";
import { runWorkflowTick } from "@/lib/workflows/engine";
import { createWorkflow, listNotifications, listRuns, saveWorkflow, setWorkflowStatus } from "@/lib/workflows/store";
import { createUser, resetDatabase } from "./helpers";

function tokenOf(url: string) {
  return url.split("/p/")[1];
}

describe("proposals", () => {
  let owner: UserActor;
  let member: UserActor;
  let pulseId: string;
  let andrewId: string;
  let outsiderId: string;
  let pilotId: string;
  let proId: string;
  let proposalTemplateId: string;
  let ndaTemplateId: string;

  before(async () => {
    process.env.SITE_URL = "https://orbit.test";
    await resetDatabase();
    owner = await createUser("mark@props.test", "Mark Ridgeon");
    pulseId = (await createCompany(owner, { name: "Pulse", domain: "pulse.test" })).body.company.id;
    andrewId = (await createContact(owner, { firstName: "Andrew", lastName: "Sanaghan", email: "andrew@pulse.test", jobTitle: "MD", companyId: pulseId })).body.contact.id;
    const other = (await createCompany(owner, { name: "Other", domain: "other.test" })).body.company.id;
    outsiderId = (await createContact(owner, { firstName: "Olly", email: "olly@other.test", companyId: other })).body.contact.id;
    const admin = getAdminPool();
    const sam = (await admin.query<{ id: string }>("select private.create_local_user('sam@props.test', 'password-123', 'Sam Colleague') as id")).rows[0].id;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, sam]);
    member = { ...owner, userId: sam, email: "sam@props.test", fullName: "Sam Colleague", role: "member", scopes: scopesForRole("member") };
  });

  after(async () => {
    await getPool().end();
  });

  it("keeps products with prices in pounds and dollars", async () => {
    await assert.rejects(() => createProduct(owner, { name: "Nothing", billing: "monthly" }), /Add a price/);
    pilotId = (await createProduct(owner, { name: "Agency Pilot", description: "Three months of AI visibility work.", priceGbp: "2,500", priceUsd: 3200, billing: "one_off" })).id;
    proId = (await createProduct(owner, { name: "Pro", description: "Monthly plan.", priceGbp: 900, billing: "monthly" })).id;
    const updated = await updateProduct(owner, proId, { description: "Monthly plan with reporting." });
    assert.equal(updated.priceGbp, 900);
    assert.deepEqual((await listProducts(owner)).map((product) => product.name), ["Agency Pilot", "Pro"]);
  });

  it("fills fields and totals", () => {
    const items = [
      { productId: null, name: "A", description: "", billing: "one_off" as const, unitPrice: 2500, quantity: 1 },
      { productId: null, name: "B", description: "", billing: "monthly" as const, unitPrice: 900, quantity: 2 },
    ];
    assert.equal(totalLabel(totalsOf(items), "GBP"), "£2,500 one-off and £1,800 a month");
    const values = fieldValues({
      company: { name: "Pulse", domain: null, website: null },
      contact: { name: "Andrew Sanaghan", firstName: "Andrew", lastName: "Sanaghan", jobTitle: null, email: "a@p.test" },
      sender: { name: "Mark", email: "m@e.test" },
      workspace: { name: "Eclipse" },
      proposal: { title: "Pilot", currency: "GBP", validUntil: "2026-11-20", items },
    });
    const rendered = renderBlocks([{ id: "b1", type: "section", heading: "Hi {{contact.firstName}}", body: "{{contact.jobTitle}} at {{company.name}}, until {{proposal.validUntil}}" }], values);
    assert.equal((rendered.blocks[0] as { heading: string }).heading, "Hi Andrew");
    assert.deepEqual(rendered.missing, ["contact.jobTitle"]);
  });

  it("only uses active templates, and needs a company and someone from it", async () => {
    const template = await createTemplate(owner, { starter: "proposal" });
    proposalTemplateId = template.id;
    await assert.rejects(
      () => createDocument(owner, { templateId: template.id, companyId: pulseId, contactId: andrewId, items: [{ productId: pilotId }] }),
      /Only active templates/,
    );
    await updateTemplate(owner, template.id, { status: "active" });
    await assert.rejects(() => createDocument(owner, { templateId: template.id, companyId: pulseId, contactId: outsiderId }), /isn't at Pulse/);
    await assert.rejects(
      () => createDocument(owner, { templateId: template.id, companyId: pulseId, contactId: andrewId, currency: "USD", items: [{ productId: proId }] }),
      /Pro has no dollar price/,
    );
    ndaTemplateId = (await createTemplate(owner, { starter: "mutual-nda" })).id;
    await updateTemplate(owner, ndaTemplateId, { status: "active" });
  });

  it("sends a locked copy, tracks opens, and needs both signatures before it is signed", async () => {
    const id = await createDocument(owner, {
      templateId: proposalTemplateId,
      companyId: pulseId,
      contactId: andrewId,
      currency: "GBP",
      items: [{ productId: pilotId }, { productId: proId, quantity: 2 }],
      title: "AI visibility pilot",
    });
    const draft = await getDocument(owner, id);
    assert.equal(draft.status, "draft");
    assert.equal(draft.totalLabel, "£2,500 one-off and £1,800 a month");
    assert.deepEqual(draft.missing, []);
    assert.equal(draft.placeholders.length, 3);
    await assert.rejects(() => sendDocument(owner, id, { email: false }), /Replace \[Describe the first deliverable\]/);
    const written = (await getTemplate(owner, proposalTemplateId)).blocks.map((block) =>
      block.type === "section" && block.heading === "What we'll do" ? { ...block, body: "- A baseline across ten assistants\n- Weekly reporting" } : block,
    );
    await updateTemplate(owner, proposalTemplateId, { blocks: written });
    await updateDocument(owner, id, { blocks: written });
    assert.deepEqual((await getDocument(owner, id)).placeholders, []);

    const sent = await sendDocument(owner, id, { email: false });
    assert.match(sent.url, /^https:\/\/orbit\.test\/p\/[A-Za-z0-9_-]{32}$/);
    const token = tokenOf(sent.url);
    await updateProduct(owner, pilotId, { priceGbp: 9999 });
    await assert.rejects(() => updateDocument(owner, id, { title: "Changed" }), /Make changes first/);

    const issued = await documentFile(owner, id, "issued");
    assert.equal(issued.data.subarray(0, 5).toString(), "%PDF-");

    const view = (await openDocument(token, { track: true, ip: "203.0.113.5", userAgent: "Safari" }))!;
    assert.equal(view.state, "open");
    assert.equal(view.content.items[0].unitPrice, 2500);
    assert.equal(view.content.client.name, "Andrew Sanaghan");
    await openDocument(token, { track: true });
    const notes = (await listNotifications(owner)).filter((note) => note.title.includes("AI visibility pilot"));
    assert.equal(notes.length, 1);
    assert.match(notes[0].title, /Andrew Sanaghan opened AI visibility pilot/);
    const tracked = await getDocument(owner, id);
    assert.equal(tracked.status, "viewed");
    assert.equal(tracked.viewCount, 2);

    await assert.rejects(() => clientSign(token, { name: "Andrew Sanaghan", signatureText: "Andrew Sanaghan" }), /Tick the box/);
    const signed = await clientSign(token, { name: "Andrew Sanaghan", title: "MD", signatureText: "Andrew Sanaghan", agree: true }, { ip: "203.0.113.5", userAgent: "Safari" });
    assert.equal(signed.state, "client_signed");
    await assert.rejects(() => clientSign(token, { name: "Andrew", signatureText: "Andrew", agree: true }), /already signed/);
    assert.ok((await listNotifications(owner)).some((note) => /Andrew Sanaghan signed AI visibility pilot/.test(note.title)));
    await assert.rejects(() => publicFile(token, "executed"), /ready once both sides/);

    await assert.rejects(() => countersignDocument(member, id, { signatureText: "Sam Colleague" }), /owner or an admin/);
    const drawn = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const done = await countersignDocument(owner, id, { signatureText: "Mark Ridgeon", title: "Founder", signatureImage: drawn });
    assert.equal(done.status, "completed");
    assert.equal(done.signatures.find((signature) => signature.role === "sender")?.signatureImage, drawn);
    assert.deepEqual(done.signatures.map((signature) => [signature.role, signature.method]), [
      ["client", "email_link"],
      ["sender", "orbit_login"],
    ]);
    const executed = await publicFile(token, "executed");
    assert.equal(executed.data.subarray(0, 5).toString(), "%PDF-");
    assert.ok(executed.data.length > issued.data.length);
    const finalView = (await openDocument(token, { track: false }))!;
    assert.equal(finalView.state, "completed");
    assert.ok(finalView.hasExecuted);
    const events = (await getDocument(owner, id)).events.map((event) => event.type);
    assert.deepEqual(events.filter((type) => type !== "downloaded" && type !== "downloaded_signed"), ["created", "sent", "viewed", "viewed", "client_signed", "countersigned", "completed"]);

    await assert.rejects(() => withActor(owner, (db) => db.query("update crm.document_signatures set name = 'x'")), /permission denied/);
    await assert.rejects(() => withActor(owner, (db) => db.query("delete from crm.document_versions")), /permission denied/);
  });

  it("starts workflows when a proposal is signed", async () => {
    await runWorkflowTick({ budgetMs: 10_000 });
    const workflow = await createWorkflow(owner, { name: "Signed" });
    await saveWorkflow(owner, workflow.id, {
      definition: {
        ...workflow.definition,
        trigger: { type: "proposal_event", event: "signed", kind: "proposal" },
        nodes: [{ id: "notify_1", type: "notify", config: { to: "owner", title: "{{proposal.signedBy}} signed {{proposal.title}} for {{company.name}} ({{proposal.total}})" }, position: { x: 0, y: 0 } }],
        edges: [{ source: "trigger", handle: "out", target: "notify_1" }],
      },
    });
    await setWorkflowStatus(owner, workflow.id, "active");
    const id = await createDocument(owner, { templateId: proposalTemplateId, companyId: pulseId, contactId: andrewId, items: [{ productId: proId }], title: "Pro plan" });
    const token = tokenOf((await sendDocument(owner, id, { email: false })).url);
    await clientSign(token, { name: "Andrew Sanaghan", signatureText: "Andrew Sanaghan", agree: true });
    await runWorkflowTick({ budgetMs: 20_000 });
    const runs = await listRuns(owner, workflow.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "succeeded");
    assert.ok((await listNotifications(owner)).some((note) => note.title === "Andrew Sanaghan signed Pro plan for Pulse (£900 a month)"));
  });

  it("replaces the link when a sent proposal is changed, and records a decline", async () => {
    const id = await createDocument(owner, { templateId: proposalTemplateId, companyId: pulseId, contactId: andrewId, items: [{ productId: pilotId }] });
    const first = tokenOf((await sendDocument(owner, id, { email: false })).url);
    await reviseDocument(owner, id);
    assert.equal((await openDocument(first, { track: false }))!.state, "replaced");
    await assert.rejects(() => clientSign(first, { name: "Andrew", signatureText: "Andrew", agree: true }), /newer version/);
    await updateDocument(owner, id, { title: "Pilot, revised" });
    const second = tokenOf((await sendDocument(owner, id, { email: false })).url);
    assert.notEqual(first, second);
    const declined = await clientDecline(second, { reason: "Budget is on hold until Q1." });
    assert.equal(declined.state, "declined");
    const detail = await getDocument(owner, id);
    assert.equal(detail.status, "declined");
    assert.equal(detail.declineReason, "Budget is on hold until Q1.");
    assert.equal(detail.version?.number, 2);
  });

  it("sends an NDA without products, and stops signing once it expires", async () => {
    const id = await createDocument(owner, { templateId: ndaTemplateId, companyId: pulseId, contactId: andrewId });
    const detail = await getDocument(owner, id);
    assert.equal(detail.kind, "nda");
    assert.equal(detail.title, "NDA with Pulse");
    const token = tokenOf((await sendDocument(owner, id, { email: false })).url);
    assert.match((await openDocument(token, { track: false }))!.content.consent, /agree to this agreement with/);
    await getAdminPool().query("update crm.documents set valid_until = current_date - 1 where id = $1", [id]);
    assert.equal((await openDocument(token, { track: false }))!.state, "expired");
    await assert.rejects(() => clientSign(token, { name: "Andrew", signatureText: "Andrew", agree: true }), /expired/);
    assert.equal((await listDocuments(owner, { status: "expired" })).length, 1);
    assert.equal(await openDocument("not-a-real-token-at-all-xxxxxx", { track: false }), null);
  });

  it("puts the template's logo on drafts, the sent copy and the PDF", async () => {
    const logo =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    await assert.rejects(
      () => updateTemplate(owner, ndaTemplateId, { settings: { accent: "#4124fb", validDays: 30, logo: "data:image/svg+xml;base64,PHN2Zz4=" } }),
      /logo must be a PNG/,
    );
    const id = await createDocument(owner, { templateId: ndaTemplateId, companyId: pulseId, contactId: andrewId });
    assert.equal((await getDocument(owner, id)).preview.logo, null);
    await updateTemplate(owner, ndaTemplateId, { settings: { accent: "#4124fb", validDays: 30, logo } });
    assert.equal((await getDocument(owner, id)).preview.logo, logo);
    const token = tokenOf((await sendDocument(owner, id, { email: false })).url);
    assert.equal((await openDocument(token, { track: false }))!.content.logo, logo);
    const issued = await documentFile(owner, id, "issued");
    assert.ok(issued && issued.data.subarray(0, 5).toString() === "%PDF-");
    await updateTemplate(owner, ndaTemplateId, { settings: { accent: "#4124fb", validDays: 30, logo: null } });
    assert.equal((await openDocument(token, { track: false }))!.content.logo, logo);
  });

  it("puts the company's deal in the Proposal stage, or adds one there", async () => {
    const stages = (await listPipeline(owner)).stages;
    const newStage = stages.find((stage) => stage.name === "New")!;
    const make = async (name: string) => {
      const companyId = (await createCompany(owner, { name, domain: `${name.toLowerCase()}.test` })).body.company.id;
      const contactId = (await createContact(owner, { firstName: name, email: `ceo@${name.toLowerCase()}.test`, companyId })).body.contact.id;
      return { companyId, contactId };
    };

    const fresh = await make("Freshco");
    const added = await createDocument(owner, { templateId: proposalTemplateId, companyId: fresh.companyId, contactId: fresh.contactId, items: [{ productId: pilotId }, { productId: proId }] });
    const deals = (await listOpportunities(owner, { companyId: fresh.companyId })).data;
    assert.equal(deals.length, 1);
    assert.equal(deals[0].stageName, "Proposal");
    assert.equal(deals[0].name, "Freshco");
    const detail = await getDocument(owner, added);
    assert.equal(Number(deals[0].value), detail.totals.one_off + detail.totals.monthly * 12 + detail.totals.yearly);
    assert.ok(detail.totals.one_off > 0 && detail.totals.monthly > 0);
    assert.equal(detail.opportunityId, deals[0].id);

    const early = await make("Earlyco");
    const deal = (await createOpportunity(owner, { companyId: early.companyId, name: "Earlyco pilot", stageId: newStage.id })).body.opportunity;
    await createDocument(owner, { templateId: proposalTemplateId, companyId: early.companyId, contactId: early.contactId, items: [{ productId: pilotId }] });
    const moved = (await listOpportunities(owner, { companyId: early.companyId })).data;
    assert.equal(moved.length, 1);
    assert.equal(moved[0].id, deal.id);
    assert.equal(moved[0].stageName, "Proposal");

    const nda = await make("Ndaco");
    await createDocument(owner, { templateId: ndaTemplateId, companyId: nda.companyId, contactId: nda.contactId });
    assert.equal((await listOpportunities(owner, { companyId: nda.companyId })).data.length, 0);
  });
});