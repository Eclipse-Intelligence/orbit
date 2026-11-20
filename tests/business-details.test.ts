import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import { PDFDocument } from "pdf-lib";
import { getBusinessDetails, saveBusinessDetails } from "@/lib/crm/business-details";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createTemplate, updateTemplate } from "@/lib/proposals/catalogue";
import { countersignDocument, createDocument, documentFile, getDocument, sendDocument } from "@/lib/proposals/documents";
import { isDarkLogo } from "@/lib/proposals/logo-shade";
import { bandAccent, businessLines, missingMessage, senderCompany, type Content } from "@/lib/proposals/model";
import { renderPdf } from "@/lib/proposals/pdf";
import { decodePng, encodePng, logoForDarkBand, logoIsDark } from "@/lib/proposals/png";
import { clientSign, openDocument } from "@/lib/proposals/public";
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

const WEB = { operation: "business_test", source: "web" };
const WORKSPACE_NAME = "Zeta Holdings Workspace";

function solidPng(width: number, height: number, rgba: [number, number, number, number]) {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) pixels.set(rgba, index);
  return encodePng({ width, height, rgba: pixels });
}

function textLogo(ink: [number, number, number, number], paper: [number, number, number, number] = [0, 0, 0, 0]) {
  const width = 8;
  const height = 4;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) pixels.set(y === 1 || y === 2 ? ink : paper, (y * width + x) * 4);
  }
  return encodePng({ width, height, rgba: pixels });
}

function dataUri(png: Buffer) {
  return `data:image/png;base64,${png.toString("base64")}`;
}

function forbidden(error: unknown) {
  assert.ok(error instanceof CrmError);
  assert.equal(error.code, "forbidden");
  assert.match(error.message, /Only owners and admins can change the business details/);
  return true;
}

describe("business details", () => {
  let owner: UserActor;
  let member: UserActor;
  let admin: UserActor;
  let stranger: UserActor;

  before(async () => {
    process.env.SITE_URL = "https://orbit.test";
    await resetDatabase();
    owner = await createUser("mark@business.test", "Mark Ridgeon");
    await getAdminPool().query("update crm.workspaces set name = $2 where id = $1", [owner.workspaceId, WORKSPACE_NAME]);
    owner = { ...owner, workspaceName: WORKSPACE_NAME };
    stranger = await createUser("olly@elsewhere.test", "Olly Other");
    const pool = getAdminPool();
    const join = async (email: string, name: string, role: "member" | "admin") => {
      const id = (await pool.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", [email, name])).rows[0].id;
      await pool.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [owner.workspaceId, id, role]);
      return { ...owner, userId: id, email, fullName: name, role, scopes: scopesForRole(role) } satisfies UserActor;
    };
    member = await join("sam@business.test", "Sam Member", "member");
    admin = await join("ada@business.test", "Ada Admin", "admin");
  });

  after(async () => {
    await getPool().end();
  });

  useServerlessPool();

  it("starts empty, and lets owners and admins save while members only read", async () => {
    assert.deepEqual(await getBusinessDetails(member), { name: "", address: "", phone: "", email: "", website: "" });
    const saved = await saveBusinessDetails(
      owner,
      { name: "  Ridgeon   Consultancy ", address: "  1 High Street \r\n\r\n  Leeds   LS1 1AA ", phone: "+44 113 496 0000", email: "hello@ridgeon.test", website: "ridgeon.test" },
      WEB,
    );
    assert.deepEqual(saved, {
      name: "Ridgeon Consultancy",
      address: "1 High Street\nLeeds LS1 1AA",
      phone: "+44 113 496 0000",
      email: "hello@ridgeon.test",
      website: "https://ridgeon.test",
    });
    assert.deepEqual(await getBusinessDetails(member), saved);
    await assert.rejects(() => saveBusinessDetails(member, { name: "Hijack" }, WEB), forbidden);
    const rows = await queryAsUser<{ business_name: string }>(
      member.userId,
      "update crm.workspace_brands set business_name = 'Hijack' where workspace_id = $1 returning business_name",
      [owner.workspaceId],
    );
    assert.equal(rows.length, 0);
    const byAdmin = await saveBusinessDetails(admin, { ...saved, phone: "0113 496 0001" }, WEB);
    assert.equal(byAdmin.phone, "0113 496 0001");
    const audit = await getAdminPool().query<{ event_type: string }>(
      "select event_type from crm.audit_events where workspace_id = $1 and event_type = 'workspace_brand.business_updated'",
      [owner.workspaceId],
    );
    assert.equal(audit.rows.length, 2);
  });

  it("checks lengths, and email and website loosely", async () => {
    const reject = (input: Record<string, string>, field: string) =>
      assert.rejects(
        () => saveBusinessDetails(owner, input, WEB),
        (error: unknown) => error instanceof CrmError && error.code === "invalid_input" && error.details?.field === field,
      );
    await reject({ name: "x".repeat(201) }, "name");
    await reject({ address: "x".repeat(501) }, "address");
    await reject({ phone: "1".repeat(51) }, "phone");
    await reject({ email: "not an email" }, "email");
    await reject({ website: "not a website" }, "website");
    await reject({ name: 42 as unknown as string }, "name");
    const cleared = await saveBusinessDetails(owner, { name: "Ridgeon Consultancy", email: "", website: "" }, WEB);
    assert.deepEqual(cleared, { name: "Ridgeon Consultancy", address: "", phone: "", email: "", website: "" });
  });

  it("never shows one workspace's details in another", async () => {
    assert.deepEqual(await getBusinessDetails(stranger), { name: "", address: "", phone: "", email: "", website: "" });
    await saveBusinessDetails(stranger, { name: "Other Ltd" }, WEB);
    assert.equal((await getBusinessDetails(owner)).name, "Ridgeon Consultancy");
    assert.equal((await getBusinessDetails(stranger)).name, "Other Ltd");
    const seen = await queryAsUser<{ business_name: string }>(stranger.userId, "select business_name from crm.workspace_brands");
    assert.deepEqual(
      seen.map((row) => row.business_name),
      ["Other Ltd"],
    );
    const agent = await createAgent(owner.workspaceId, ["crm:read"]);
    assert.equal((await getBusinessDetails(agent.actor)).name, "Ridgeon Consultancy");
    const strangerAgent = await createAgent(stranger.workspaceId, ["crm:read"]);
    assert.equal((await getBusinessDetails(strangerAgent.actor)).name, "Other Ltd");
  });

  it("prints the sender's name in From, never the workspace name, and uses the business name where a company is needed", async () => {
    await saveBusinessDetails(owner, { name: "" }, WEB);
    const companyId = (await createCompany(owner, { name: "Isothermal Services", domain: "isothermal.test" })).body.company.id;
    const contactId = (await createContact(owner, { firstName: "Ashley", lastName: "Stone", email: "ashley@isothermal.test", companyId })).body.contact.id;
    const template = await createTemplate(owner, { starter: "mutual-nda" });
    await updateTemplate(owner, template.id, { status: "active" });

    const plain = await createDocument(owner, { templateId: template.id, companyId, contactId });
    const draft = (await getDocument(owner, plain)).preview;
    assert.equal(draft.sender.company, "Mark Ridgeon");
    assert.equal(senderCompany(draft), "Mark Ridgeon");
    assert.ok(!JSON.stringify(draft).includes(WORKSPACE_NAME));
    assert.match(draft.consent, /with Mark Ridgeon,/);
    assert.deepEqual((await getDocument(owner, plain)).missing, ["workspace.name"]);
    await assert.rejects(() => sendDocument(owner, plain, { email: false }), /Add a business name in Settings › Brand before sending/);

    const custom = await createTemplate(owner, { starter: "mutual-nda" });
    await updateTemplate(owner, custom.id, {
      status: "active",
      blocks: [
        { id: "b1", type: "cover", title: "Confidentiality", subtitle: "From {{sender.name}} to {{company.name}}.", image: "" },
        { id: "b2", type: "section", heading: "Terms", body: "We keep what you share private." },
      ],
    });
    const unnamed = await createDocument(owner, { templateId: custom.id, companyId, contactId });
    const unnamedToken = (await sendDocument(owner, unnamed, { email: false })).url.split("/p/")[1];
    const unnamedContent = (await openDocument(unnamedToken, { track: false }))!.content;
    assert.equal(senderCompany(unnamedContent), "Mark Ridgeon");
    assert.match(unnamedContent.consent, /with Mark Ridgeon,/);
    assert.ok(!JSON.stringify(unnamedContent).includes(WORKSPACE_NAME));

    await saveBusinessDetails(
      owner,
      { name: "Ridgeon Consultancy", address: "1 High Street\nLeeds", phone: "0113 496 0000", email: "hello@ridgeon.test", website: "ridgeon.test" },
      WEB,
    );
    const id = await createDocument(owner, { templateId: template.id, companyId, contactId });
    const agent = await createAgent(owner.workspaceId, ["crm:read"]);
    assert.equal((await getDocument(agent.actor, id)).preview.business?.name, "Ridgeon Consultancy");
    const token = (await sendDocument(owner, id, { email: false })).url.split("/p/")[1];
    const view = (await openDocument(token, { track: false }))!;
    const content = view.content;
    assert.equal(content.sender.name, "Mark Ridgeon");
    assert.equal(content.sender.company, "Ridgeon Consultancy");
    assert.deepEqual(content.business, {
      name: "Ridgeon Consultancy",
      address: "1 High Street\nLeeds",
      phone: "0113 496 0000",
      email: "hello@ridgeon.test",
      website: "https://ridgeon.test",
    });
    assert.match(content.consent, /with Ridgeon Consultancy,/);
    assert.ok(!JSON.stringify(content).includes(WORKSPACE_NAME));
    assert.match(JSON.stringify(content.blocks), /Between Ridgeon Consultancy and Isothermal Services/);
    assert.deepEqual(
      businessLines(content.business).map((line) => [line.key, line.text, line.href]),
      [
        ["name", "Ridgeon Consultancy", null],
        ["address", "1 High Street\nLeeds", null],
        ["phone", "0113 496 0000", "tel:01134960000"],
        ["email", "hello@ridgeon.test", "mailto:hello@ridgeon.test"],
        ["website", "ridgeon.test", "https://ridgeon.test/"],
      ],
    );

    await saveBusinessDetails(owner, { name: "Renamed Ltd" }, WEB);
    assert.equal((await openDocument(token, { track: false }))!.content.business?.name, "Ridgeon Consultancy");

    await clientSign(token, { name: "Ashley Stone", signatureText: "Ashley Stone", agree: true, hash: view.hash });
    await countersignDocument(owner, id, { signatureText: "Mark Ridgeon" });
    const signatures = await getAdminPool().query<{ role: string; company: string | null }>("select role, company from crm.document_signatures where document_id = $1", [id]);
    assert.equal(signatures.rows.find((row) => row.role === "sender")?.company, "Ridgeon Consultancy");
    const executed = await documentFile(owner, id, "executed");
    assert.equal(executed.data.subarray(0, 5).toString(), "%PDF-");

    const old = await createDocument(owner, { templateId: template.id, companyId, contactId });
    const oldToken = (await sendDocument(owner, old, { email: false })).url.split("/p/")[1];
    await getAdminPool().query(`update crm.document_versions set content = jsonb_set(content - 'business', '{sender,company}', '"Eclipse"') where document_id = $1`, [old]);
    const oldView = (await openDocument(oldToken, { track: false }))!;
    assert.equal(oldView.content.business, undefined);
    assert.equal(senderCompany(oldView.content), "Eclipse");
    await clientSign(oldToken, { name: "Ashley Stone", signatureText: "Ashley Stone", agree: true, hash: oldView.hash });
    await countersignDocument(owner, old, { signatureText: "Mark Ridgeon" });
    const oldSignatures = await getAdminPool().query<{ role: string; company: string | null }>("select role, company from crm.document_signatures where document_id = $1", [old]);
    assert.equal(oldSignatures.rows.find((row) => row.role === "sender")?.company, "Eclipse");
  });

  it("shows a sent version with the party it was sent with, and new versions with the business name or the sender", async () => {
    const stored = {
      sender: { name: "Mark Ridgeon", email: "mark@business.test", title: null, company: "Eclipse" },
    } as Pick<Content, "sender" | "business">;
    assert.equal(senderCompany(stored), "Eclipse");
    assert.equal(senderCompany({ ...stored, business: { name: "  ", address: "", phone: "", email: "", website: "" } }), "Mark Ridgeon");
    assert.equal(senderCompany({ ...stored, business: { name: "Ridgeon Consultancy", address: "", phone: "", email: "", website: "" } }), "Ridgeon Consultancy");
    assert.deepEqual(businessLines(undefined), []);
    assert.equal(missingMessage(["workspace.name"]), "Add a business name in Settings › Brand before sending.");
    assert.equal(missingMessage(["contact.jobTitle", "workspace.name"]), "Fill in {{contact.jobTitle}} and add a business name in Settings › Brand before sending.");
    assert.equal(missingMessage(["contact.jobTitle"]), "Fill in {{contact.jobTitle}} before sending.");
  });

  it("keeps the band accent visible on a dark band", () => {
    assert.equal(bandAccent("#4124fb"), "#4124fb");
    assert.equal(bandAccent("#0a0a0a"), "#ffffff");
    assert.equal(bandAccent("#101820"), "#ffffff");
    assert.equal(bandAccent("nonsense"), "#ffffff");
  });

  it("whitens a dark logo for the band and leaves a light one alone", async () => {
    const black = textLogo([10, 10, 10, 255]);
    const white = textLogo([250, 250, 250, 255]);
    const transparent = solidPng(4, 4, [0, 0, 0, 0]);
    const navyTile = textLogo([255, 255, 255, 255], [16, 24, 64, 255]);
    const blackTile = solidPng(8, 4, [10, 10, 10, 255]);
    assert.equal(logoIsDark(dataUri(black)), true);
    assert.equal(logoIsDark(dataUri(navyTile)), false);
    assert.equal(logoIsDark(dataUri(blackTile)), false);
    assert.ok(logoForDarkBand(dataUri(navyTile))!.equals(navyTile));
    assert.ok(logoForDarkBand(dataUri(blackTile))!.equals(blackTile));
    assert.equal(logoIsDark(dataUri(white)), false);
    assert.equal(logoIsDark(dataUri(transparent)), false);
    assert.equal(logoIsDark(null), false);
    const whitened = decodePng(logoForDarkBand(dataUri(black))!)!;
    assert.deepEqual([...whitened.rgba.subarray(0, 4)], [255, 255, 255, 0]);
    assert.deepEqual([...whitened.rgba.subarray(36, 40)], [255, 255, 255, 255]);
    assert.ok(logoForDarkBand(dataUri(white))!.equals(white));
    const palette = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 8, 3, 0, 0, 0])),
      chunk("PLTE", Buffer.from([0, 0, 0, 255, 255, 255])),
      chunk("tRNS", Buffer.from([255, 0])),
      chunk("IDAT", deflateSync(Buffer.from([0, 0, 1]))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const decoded = decodePng(palette)!;
    assert.deepEqual([...decoded.rgba], [0, 0, 0, 255, 255, 255, 255, 0]);
    assert.equal(isDarkLogo(decoded.rgba), true);
    assert.equal(decodePng(Buffer.from("not a png")), null);
  });

  it("renders the PDF band with a whitened logo and the business details", async () => {
    const content: Content = {
      kind: "proposal",
      title: "Your new website",
      currency: "GBP",
      validUntil: "2026-12-20",
      accent: "#4124fb",
      logo: dataUri(textLogo([0, 0, 0, 255])),
      client: { name: "Ashley Stone", email: "ashley@isothermal.test", title: null, company: "Isothermal Services" },
      sender: { name: "Mark Ridgeon", email: "mark@business.test", title: null, company: "Ridgeon Consultancy" },
      business: { name: "Ridgeon Consultancy", address: "1 High Street\nLeeds", phone: "0113 496 0000", email: "hello@ridgeon.test", website: "https://ridgeon.test" },
      blocks: [{ id: "b1", type: "cover", title: "Your new website", subtitle: "For Ashley at Isothermal Services", image: "" }],
      items: [],
      totals: { one_off: 0, monthly: 0, yearly: 0 },
      consent: "By typing your name you agree.",
      issuedAt: "2026-11-20T10:00:00.000Z",
    };
    const pdf = await renderPdf({ content, contentHash: "0".repeat(64), documentId: "00000000-0000-0000-0000-000000000000", versionNumber: 1 });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.equal((await PDFDocument.load(pdf)).getAuthor(), "Ridgeon Consultancy");
    const old = await renderPdf({
      content: { ...content, business: undefined, sender: { ...content.sender, company: "Eclipse" }, logo: null },
      contentHash: "0".repeat(64),
      documentId: "00000000-0000-0000-0000-000000000000",
      versionNumber: 1,
    });
    assert.equal((await PDFDocument.load(old)).getAuthor(), "Eclipse");
  });
});

function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body, Buffer.alloc(4)]);
}
