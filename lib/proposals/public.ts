import { memberActor } from "@/lib/crm/conversations";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { recordAudit } from "@/lib/crm/mutate";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { documentHref, hashToken, isExpired, logEvent, readRow, SIGNATURE_COLUMNS, toSignature, type SignatureRecord, type SignatureRow } from "@/lib/proposals/documents";
import type { Content, DocumentStatus } from "@/lib/proposals/model";
import { pushToUser, type PushSender } from "@/lib/push";
import { loadBookingPage, publicView, type PublicBookingPage } from "@/lib/booking/pages";
import { readObject } from "@/lib/storage";
import { notify } from "@/lib/workflows/engine";

export type PublicState = "open" | "client_signed" | "completed" | "declined" | "withdrawn" | "replaced" | "expired";

export type PublicDocument = {
  documentId: string;
  state: PublicState;
  content: Content;
  versionNumber: number;
  hash: string;
  signatures: SignatureRecord[];
  declineReason: string | null;
  hasExecuted: boolean;
  booking: PublicBookingPage | null;
};

type LinkRow = {
  document_id: string;
  link_id: string;
  version_id: string;
  revoked: boolean;
  workspace_id: string;
  workspace_name: string;
  user_id: string;
  role: WorkspaceRole;
  email: string | null;
  full_name: string | null;
};

type Meta = { ip?: string | null; userAgent?: string | null; push?: PushSender };

const VIEW_ALERT_GAP_MS = 60 * 60 * 1000;

async function resolve(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const result = await query<LinkRow>("select * from private.document_link_owner($1)", [hashToken(token)]);
  const row = result.rows[0];
  if (!row) return null;
  return { row, owner: memberActor(row) };
}

function stateFor(status: DocumentStatus, validUntil: string | null, revoked: boolean, current: boolean): PublicState {
  if (status === "completed" && current) return "completed";
  if (status === "client_signed" && current) return "client_signed";
  if (status === "withdrawn") return "withdrawn";
  if (revoked || !current) return "replaced";
  if (status === "declined") return "declined";
  if (isExpired(status, validUntil)) return "expired";
  return "open";
}

async function load(owner: UserActor, link: LinkRow) {
  return withActor(owner, async (db) => {
    const row = await readRow(db, owner, link.document_id);
    const versionId = link.revoked ? link.version_id : (row.current_version_id ?? link.version_id);
    const version = await db.query<{ number: number; content: Content; content_hash: string }>(
      "select number, content, content_hash from crm.document_versions where id = $1",
      [versionId],
    );
    const signatures = await db.query<SignatureRow>(`select ${SIGNATURE_COLUMNS} from crm.document_signatures where version_id = $1 order by signed_at`, [versionId]);
    const executed = await db.query<{ id: string }>("select id from crm.document_files where version_id = $1 and kind = 'executed'", [versionId]);
    const current = row.current_version_id === versionId;
    return {
      row,
      versionId,
      view: {
        documentId: row.id,
        state: stateFor(row.status, row.valid_until, link.revoked, current),
        content: version.rows[0].content,
        versionNumber: version.rows[0].number,
        hash: version.rows[0].content_hash,
        signatures: signatures.rows.map(toSignature),
        declineReason: row.decline_reason,
        hasExecuted: executed.rows.length > 0,
        booking: null,
      } satisfies PublicDocument,
    };
  });
}

async function alertOwner(owner: UserActor, input: { key: string; title: string; body: string; href: string }, push?: PushSender) {
  const fresh = await withActor(owner, async (db) => {
    const result = await db.query(
      `insert into crm.push_log (workspace_id, user_id, key) values ($1, $2, $3) on conflict (user_id, key) do nothing returning id`,
      [owner.workspaceId, owner.userId, input.key.slice(0, 500)],
    );
    return (result.rowCount ?? 0) > 0;
  });
  if (!fresh) return;
  await notify(owner, owner.userId, { title: input.title.slice(0, 200), body: input.body, href: input.href, source: "proposal" }).catch(() => undefined);
  await pushToUser(owner, { title: input.title, body: input.body, url: input.href, tag: input.key }, { send: push }).catch((error) => console.error("Proposal push failed", error));
}

async function bookingFor(owner: UserActor) {
  const page = await withActor(owner, async (db) => {
    const result = await db.query<{ slug: string; enabled: boolean }>("select slug, enabled from crm.booking_pages where user_id = $1 and workspace_id = $2", [
      owner.userId,
      owner.workspaceId,
    ]);
    return result.rows[0] ?? null;
  });
  if (!page?.enabled) return null;
  const loaded = await loadBookingPage(page.slug);
  return loaded ? publicView(loaded) : null;
}

export async function openDocument(token: string, meta: Meta & { track: boolean }) {
  const found = await resolve(token);
  if (!found) return null;
  const { row, view: loaded, versionId } = await load(found.owner, found.row);
  const view = loaded.content.blocks.some((block) => block.type === "booking") ? { ...loaded, booking: await bookingFor(found.owner).catch(() => null) } : loaded;
  if (!meta.track || found.row.revoked) return view;
  const outcome = await withActor(found.owner, async (db) => {
    const before = await db.query<{ last_viewed_at: Date | null; status: DocumentStatus }>("select last_viewed_at, status from crm.documents where id = $1", [row.id]);
    await db.query(
      `update crm.documents set view_count = view_count + 1, last_viewed_at = now(), first_viewed_at = coalesce(first_viewed_at, now()),
         status = case when status = 'sent' then 'viewed' else status end
       where id = $1`,
      [row.id],
    );
    await logEvent(db, {
      workspaceId: found.owner.workspaceId,
      documentId: row.id,
      versionId,
      type: "viewed",
      actor: "client",
      name: view.content.client.name,
      email: view.content.client.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    const first = before.rows[0]?.status === "sent";
    if (first) await recordAudit(db, found.owner, "document.viewed", "document", row.id, { operation: "view_proposal", source: "proposal_page" }, { title: row.title });
    return { first, last: before.rows[0]?.last_viewed_at ?? null };
  });
  const quietFor = outcome.last ? Date.now() - new Date(outcome.last).getTime() : Infinity;
  if (outcome.first || quietFor > VIEW_ALERT_GAP_MS) {
    const who = row.contact_name ?? "Your contact";
    await alertOwner(
      found.owner,
      {
        key: `doc-view:${row.id}:${Math.floor(Date.now() / VIEW_ALERT_GAP_MS)}`,
        title: `${who} ${outcome.first ? "opened" : "is looking at"} ${row.title}`,
        body: `${row.company_name}${outcome.first ? ", for the first time" : ""}.`,
        href: documentHref(row.id),
      },
      meta.push,
    );
  }
  return view;
}

export async function clientSign(
  token: string,
  input: { name?: unknown; title?: unknown; company?: unknown; signatureText?: unknown; signatureImage?: unknown; agree?: unknown },
  meta: Meta = {},
) {
  const found = await resolve(token);
  if (!found) throw new CrmError("not_found", "This link isn't valid.", 404);
  const { row, view, versionId } = await load(found.owner, found.row);
  if (view.state !== "open") throw new CrmError("conflict", stateMessage(view.state), 409);
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  const signatureText = typeof input.signatureText === "string" ? input.signatureText.replace(/\s+/g, " ").trim() : "";
  if (name.length < 2 || name.length > 200) throw new CrmError("invalid_input", "Enter your full name.", 400, { field: "name" });
  if (signatureText.length < 2 || signatureText.length > 200) throw new CrmError("invalid_input", "Type your name to sign.", 400, { field: "signatureText" });
  if (input.agree !== true) throw new CrmError("invalid_input", "Tick the box to agree to sign electronically.", 400, { field: "agree" });
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) || null : null;
  const company = typeof input.company === "string" ? input.company.trim().slice(0, 200) || null : view.content.client.company;
  const image =
    typeof input.signatureImage === "string" && input.signatureImage.startsWith("data:image/png;base64,") && input.signatureImage.length < 300_000 ? input.signatureImage : null;
  await withActor(found.owner, async (db) => {
    await db.query(
      `insert into crm.document_signatures (workspace_id, document_id, version_id, role, name, email, title, company, signature_text, signature_image, consent, method, ip, user_agent)
       values ($1, $2, $3, 'client', $4, $5, $6, $7, $8, $9, $10, 'email_link', $11, $12)`,
      [
        found.owner.workspaceId,
        row.id,
        versionId,
        name,
        view.content.client.email,
        title,
        company,
        signatureText,
        image,
        view.content.consent,
        meta.ip?.slice(0, 100) ?? null,
        meta.userAgent?.slice(0, 400) ?? null,
      ],
    );
    await logEvent(db, {
      workspaceId: found.owner.workspaceId,
      documentId: row.id,
      versionId,
      type: "client_signed",
      actor: "client",
      name,
      email: view.content.client.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
      data: { consent: view.content.consent, hash: view.hash },
    });
    await db.query("update crm.documents set status = 'client_signed', client_signed_at = now(), updated_at = now() where id = $1", [row.id]);
    await recordAudit(db, found.owner, "document.signed", "document", row.id, { operation: "client_sign", source: "proposal_page" }, { title: row.title, signer: name });
  });
  await alertOwner(
    found.owner,
    {
      key: `doc-signed:${row.id}:${versionId}`,
      title: `${name} signed ${row.title}`,
      body: `${row.company_name}. Countersign it in Orbit to complete it.`,
      href: documentHref(row.id),
    },
    meta.push,
  );
  return (await openDocument(token, { track: false }))!;
}

export async function clientDecline(token: string, input: { reason?: unknown }, meta: Meta = {}) {
  const found = await resolve(token);
  if (!found) throw new CrmError("not_found", "This link isn't valid.", 404);
  const { row, view, versionId } = await load(found.owner, found.row);
  if (view.state !== "open") throw new CrmError("conflict", stateMessage(view.state), 409);
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 2000) || null : null;
  await withActor(found.owner, async (db) => {
    await db.query("update crm.documents set status = 'declined', declined_at = now(), decline_reason = $2, updated_at = now() where id = $1", [row.id, reason]);
    await logEvent(db, {
      workspaceId: found.owner.workspaceId,
      documentId: row.id,
      versionId,
      type: "declined",
      actor: "client",
      email: view.content.client.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
      data: { reason },
    });
    await recordAudit(db, found.owner, "document.declined", "document", row.id, { operation: "client_decline", source: "proposal_page" }, { title: row.title, reason });
  });
  await alertOwner(
    found.owner,
    { key: `doc-declined:${row.id}:${versionId}`, title: `${row.contact_name ?? "Your contact"} declined ${row.title}`, body: reason ?? row.company_name, href: documentHref(row.id) },
    meta.push,
  );
  return (await openDocument(token, { track: false }))!;
}

export async function publicFile(token: string, kind: "issued" | "executed") {
  const found = await resolve(token);
  if (!found) throw new CrmError("not_found", "This link isn't valid.", 404);
  const { versionId } = await load(found.owner, found.row);
  return withActor(found.owner, async (db) => {
    const file = await db.query<{ data: Buffer; title: string }>(
      "select f.data, d.title from crm.document_files f join crm.documents d on d.id = f.document_id where f.version_id = $1 and f.kind = $2",
      [versionId, kind],
    );
    if (!file.rows[0]) throw new CrmError("not_found", kind === "executed" ? "The signed copy is ready once both sides have signed." : "PDF not found.", 404);
    if (kind === "issued" && found.row.revoked) throw new CrmError("not_found", "This version has been replaced.", 404);
    await logEvent(db, { workspaceId: found.owner.workspaceId, documentId: found.row.document_id, versionId, type: kind === "executed" ? "downloaded_signed" : "downloaded", actor: "client" });
    return { data: file.rows[0].data, filename: `${file.rows[0].title.replace(/[^\w\s.-]+/g, "").trim().slice(0, 80) || "document"}${kind === "executed" ? " (signed)" : ""}.pdf` };
  });
}

function stateMessage(state: PublicState) {
  switch (state) {
    case "client_signed":
      return "You've already signed this.";
    case "completed":
      return "This has been signed by both sides.";
    case "declined":
      return "This was declined.";
    case "withdrawn":
      return "This has been withdrawn.";
    case "replaced":
      return "There's a newer version of this. Use the latest link you were sent.";
    case "expired":
      return "This has expired. Ask the sender for a new one.";
    default:
      return "";
  }
}

export async function publicKnowledgeFile(token: string, itemId: string, meta: Meta & { track: boolean }) {
  const found = await resolve(token);
  if (!found) throw new CrmError("not_found", "This link isn't valid.", 404);
  const { row, view, versionId } = await load(found.owner, found.row);
  if (view.state === "withdrawn" || view.state === "replaced") throw new CrmError("not_found", stateMessage(view.state), 404);
  const listed = view.content.blocks.some((block) => block.type === "documents" && block.items.some((item) => item.id === itemId));
  if (!listed) throw new CrmError("not_found", "That document isn't part of this proposal.", 404);
  const item = await withActor(found.owner, async (db) => {
    const result = await db.query<{ title: string; kind: string; source_url: string | null; file_path: string | null; mime_type: string | null; content: string | null }>(
      "select title, kind, source_url, file_path, mime_type, content from crm.knowledge_items where id = $1 and workspace_id = $2 and archived_at is null",
      [itemId, found.owner.workspaceId],
    );
    const current = result.rows[0];
    if (!current || !meta.track) return current ?? null;
    await logEvent(db, {
      workspaceId: found.owner.workspaceId,
      documentId: row.id,
      versionId,
      type: "document_opened",
      actor: "client",
      name: view.content.client.name,
      email: view.content.client.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
      data: { itemId, title: current.title },
    });
    return current;
  });
  if (!item) throw new CrmError("not_found", "That document has been removed.", 404);
  if (meta.track) await alertOwner(
    found.owner,
    {
      key: `doc-file:${row.id}:${itemId}:${Math.floor(Date.now() / VIEW_ALERT_GAP_MS)}`,
      title: `${row.contact_name ?? "Your contact"} opened ${item.title}`,
      body: `In ${row.title}, ${row.company_name}.`,
      href: documentHref(row.id),
    },
    meta.push,
  ).catch(() => undefined);
  if (item.file_path) {
    const data = await readObject(item.file_path, fetch, "knowledge");
    const name = item.file_path.split("/").pop() ?? item.title;
    return { kind: "file" as const, data, name, contentType: item.mime_type ?? "application/octet-stream" };
  }
  if (item.source_url) return { kind: "link" as const, url: item.source_url };
  return { kind: "file" as const, data: new TextEncoder().encode(item.content ?? ""), name: `${item.title}.txt`, contentType: "text/plain; charset=utf-8" };
}
