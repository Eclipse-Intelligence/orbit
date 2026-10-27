import { createHash } from "node:crypto";
import { after } from "next/server";
import { memberActor } from "@/lib/crm/conversations";
import { withActor } from "@/lib/crm/context";
import { CrmError, isPgError } from "@/lib/crm/errors";
import { recordAudit } from "@/lib/crm/mutate";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { query } from "@/lib/db/pool";
import { documentHref, hashToken, isExpired, logEvent, readRow, SIGNATURE_COLUMNS, toSignature, type SignatureRow } from "@/lib/proposals/documents";
import { READING_SECONDS_MAX, READING_TABS_MAX, tabsOf, totalsOf, type Content, type DocumentStatus, type Step } from "@/lib/proposals/model";
import { cleanSignerText, signatureImage } from "@/lib/proposals/signature";
import { readSteps } from "@/lib/proposals/steps";
import { pushToUser, type PushSender } from "@/lib/push";
import { loadBookingPage, publicView, type PublicBookingPage } from "@/lib/booking/pages";
import { readObject } from "@/lib/storage";
import { notify } from "@/lib/workflows/engine";

export type PublicState = "open" | "updating" | "client_signed" | "completed" | "declined" | "withdrawn" | "replaced" | "expired";

export type PublicSignature = {
  role: "client" | "sender";
  name: string;
  title: string | null;
  company: string | null;
  signatureText: string;
  signatureImage: string | null;
  signedAt: string;
};

export type PublicDocument = {
  state: PublicState;
  content: Content;
  versionNumber: number;
  hash: string;
  signatures: PublicSignature[];
  declineReason: string | null;
  hasExecuted: boolean;
  booking: PublicBookingPage | null;
  steps: Step[];
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
const VIEW_REPEAT_MS = 30 * 60 * 1000;
const CHANGED = "This has changed since you opened it. Reload the page before signing.";

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
  if (status === "draft") return "updating";
  if (status === "declined") return "declined";
  if (isExpired(status, validUntil)) return "expired";
  return "open";
}

function closedContent(content: Content): Content {
  return { ...content, blocks: [], items: [], totals: totalsOf([]), client: { ...content.client, email: "" } };
}

async function loadIn(db: Db, owner: UserActor, link: LinkRow, lock = false) {
  const row = await readRow(db, owner, link.document_id, lock);
  const versionId = link.revoked ? link.version_id : (row.current_version_id ?? link.version_id);
  const version = await db.query<{ number: number; content: Content; content_hash: string }>("select number, content, content_hash from crm.document_versions where id = $1", [
    versionId,
  ]);
  const signatures = await db.query<SignatureRow>(`select ${SIGNATURE_COLUMNS} from crm.document_signatures where version_id = $1 order by signed_at`, [versionId]);
  const executed = await db.query<{ id: string }>("select id from crm.document_files where version_id = $1 and kind = 'executed'", [versionId]);
  const state = stateFor(row.status, row.valid_until, link.revoked, row.current_version_id === versionId);
  const closed = state === "withdrawn" || state === "replaced";
  const content = version.rows[0].content;
  return {
    row,
    versionId,
    content,
    view: {
      state,
      content: closed ? closedContent(content) : content,
      versionNumber: version.rows[0].number,
      hash: version.rows[0].content_hash,
      signatures: signatures.rows.map(toSignature).map((signature) => ({
        role: signature.role,
        name: signature.name,
        title: signature.title,
        company: signature.company,
        signatureText: signature.signatureText,
        signatureImage: signature.signatureImage ?? null,
        signedAt: signature.signedAt,
      })),
      declineReason: closed ? null : row.decline_reason,
      hasExecuted: executed.rows.length > 0,
      booking: null,
      steps: closed ? [] : await readSteps(db, row.id),
    } satisfies PublicDocument,
  };
}

async function load(owner: UserActor, link: LinkRow) {
  return withActor(owner, (db) => loadIn(db, owner, link));
}

async function alertOwner(owner: UserActor, input: { key: string; title: string; body: string; href: string }, push?: PushSender) {
  const fresh = await withActor(owner, async (db) => {
    const result = await db.query(`insert into crm.push_log (workspace_id, user_id, key) values ($1, $2, $3) on conflict (user_id, key) do nothing returning id`, [
      owner.workspaceId,
      owner.userId,
      input.key.slice(0, 500),
    ]);
    return (result.rowCount ?? 0) > 0;
  });
  if (!fresh) return;
  await notify(owner, owner.userId, { title: input.title.slice(0, 200), body: input.body, href: input.href, source: "proposal" }).catch(() => undefined);
  await pushToUser(owner, { title: input.title, body: input.body, url: input.href, tag: input.key }, { send: push }).catch((error) => console.error("Proposal push failed", error));
}

async function scheduleAlert(owner: UserActor, input: { key: string; title: string; body: string; href: string }, push?: PushSender) {
  const run = () => alertOwner(owner, input, push).catch((error) => console.error("Proposal alert failed", error));
  try {
    after(run);
  } catch {
    await run();
  }
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

async function allowed(key: string, limit: number, seconds: number) {
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [key, limit, seconds]);
  return result.rows[0]?.allowed !== false;
}

export async function openDocument(token: string, meta: Meta & { track: boolean }) {
  const found = await resolve(token);
  if (!found) return null;
  const { row, view: loaded, versionId } = await load(found.owner, found.row);
  const view = loaded.content.blocks.some((block) => block.type === "booking") ? { ...loaded, booking: await bookingFor(found.owner).catch(() => null) } : loaded;
  if (!meta.track || found.row.revoked || view.state === "withdrawn" || view.state === "replaced") return view;
  if (meta.ip && !(await allowed(`proposal-view:${meta.ip}`, 60, 600))) return view;
  const outcome = await withActor(found.owner, async (db) => {
    if (meta.ip) {
      const recent = await db.query(
        "select 1 from crm.document_events where document_id = $1 and type = 'viewed' and ip = $2 and occurred_at > now() - make_interval(secs => $3) limit 1",
        [row.id, meta.ip.slice(0, 100), VIEW_REPEAT_MS / 1000],
      );
      if ((recent.rowCount ?? 0) > 0) return null;
    }
    const updated = await db.query<{ was: DocumentStatus; last: Date | null }>(
      `with before as (select status, last_viewed_at from crm.documents where id = $1 for update)
       update crm.documents d set view_count = d.view_count + 1, last_viewed_at = now(), first_viewed_at = coalesce(d.first_viewed_at, now()),
         status = case when d.status = 'sent' then 'viewed' else d.status end
       from before where d.id = $1
       returning before.status as was, before.last_viewed_at as last`,
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
    const first = updated.rows[0]?.was === "sent";
    if (first) await recordAudit(db, found.owner, "document.viewed", "document", row.id, { operation: "view_proposal", source: "proposal_page" }, { title: row.title });
    return { first, last: updated.rows[0]?.last ?? null };
  });
  if (!outcome) return view;
  const quietFor = outcome.last ? Date.now() - new Date(outcome.last).getTime() : Infinity;
  if (outcome.first || quietFor > VIEW_ALERT_GAP_MS) {
    const who = row.contact_name ?? "Your contact";
    await scheduleAlert(
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

function checkVersion(expected: unknown, hash: string) {
  if (typeof expected !== "string" || expected !== hash) throw new CrmError("conflict", CHANGED, 409);
}

export async function clientSign(
  token: string,
  input: { name?: unknown; title?: unknown; company?: unknown; signatureText?: unknown; signatureImage?: unknown; agree?: unknown; hash?: unknown },
  meta: Meta = {},
) {
  const found = await resolve(token);
  if (!found) throw new CrmError("not_found", "This link isn't valid.", 404);
  const name = cleanSignerText(input.name, 200);
  const signatureText = cleanSignerText(input.signatureText, 200);
  if (name.length < 2) throw new CrmError("invalid_input", "Enter your full name.", 400, { field: "name" });
  if (signatureText.length < 2) throw new CrmError("invalid_input", "Type your name to sign.", 400, { field: "signatureText" });
  if (input.agree !== true) throw new CrmError("invalid_input", "Tick the box to agree to sign electronically.", 400, { field: "agree" });
  const title = cleanSignerText(input.title, 200) || null;
  const image = input.signatureImage === undefined || input.signatureImage === null ? null : signatureImage(input.signatureImage);
  if (input.signatureImage && !image) throw new CrmError("invalid_input", "That signature couldn't be read. Clear it and draw it again.", 400, { field: "signatureImage" });
  const signed = await withActor(found.owner, async (db) => {
    const { row, view, versionId } = await loadIn(db, found.owner, found.row, true);
    if (view.state !== "open") throw new CrmError("conflict", stateMessage(view.state), 409);
    checkVersion(input.hash, view.hash);
    const company = cleanSignerText(input.company, 200) || view.content.client.company;
    try {
      await db.query(
        `insert into crm.document_signatures (workspace_id, document_id, version_id, role, name, email, title, company, signature_text, signature_image, consent, method, ip, user_agent)
         values ($1, $2, $3, 'client', $4, $5, $6, $7, $8, $9, $10, 'email_link', $11, $12)`,
        [found.owner.workspaceId, row.id, versionId, name, view.content.client.email, title, company, signatureText, image, view.content.consent, meta.ip?.slice(0, 100) ?? null, meta.userAgent?.slice(0, 400) ?? null],
      );
    } catch (error) {
      if (isPgError(error) && error.code === "23505") throw new CrmError("conflict", stateMessage("client_signed"), 409);
      throw error;
    }
    const moved = await db.query("update crm.documents set status = 'client_signed', client_signed_at = now(), updated_at = now() where id = $1 and status in ('sent', 'viewed') returning id", [row.id]);
    if (moved.rowCount === 0) throw new CrmError("conflict", CHANGED, 409);
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
      data: { consent: view.content.consent, hash: view.hash, drawn: Boolean(image) },
    });
    await recordAudit(db, found.owner, "document.signed", "document", row.id, { operation: "client_sign", source: "proposal_page" }, { title: row.title, signer: name });
    return { row, versionId };
  });
  await scheduleAlert(
    found.owner,
    {
      key: `doc-signed:${signed.row.id}:${signed.versionId}`,
      title: `${name} signed ${signed.row.title}`,
      body: `${signed.row.company_name}. Countersign it in Orbit to complete it.`,
      href: documentHref(signed.row.id),
    },
    meta.push,
  );
  return (await openDocument(token, { track: false }))!;
}

export async function clientDecline(token: string, input: { reason?: unknown; hash?: unknown }, meta: Meta = {}) {
  const found = await resolve(token);
  if (!found) throw new CrmError("not_found", "This link isn't valid.", 404);
  const reason = cleanSignerText(input.reason, 2000) || null;
  const declined = await withActor(found.owner, async (db) => {
    const { row, view, versionId } = await loadIn(db, found.owner, found.row, true);
    if (view.state !== "open") throw new CrmError("conflict", stateMessage(view.state), 409);
    checkVersion(input.hash, view.hash);
    const moved = await db.query(
      "update crm.documents set status = 'declined', declined_at = now(), decline_reason = $2, updated_at = now() where id = $1 and status in ('sent', 'viewed') returning id",
      [row.id, reason],
    );
    if (moved.rowCount === 0) throw new CrmError("conflict", CHANGED, 409);
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
    return { row, versionId };
  });
  await scheduleAlert(
    found.owner,
    {
      key: `doc-declined:${declined.row.id}:${declined.versionId}`,
      title: `${declined.row.contact_name ?? "Your contact"} declined ${declined.row.title}`,
      body: reason ?? declined.row.company_name,
      href: documentHref(declined.row.id),
    },
    meta.push,
  );
  return (await openDocument(token, { track: false }))!;
}

export async function publicFile(token: string, kind: "issued" | "executed", meta: { track: boolean } = { track: true }) {
  const found = await resolve(token);
  if (!found) throw new CrmError("not_found", "This link isn't valid.", 404);
  return withActor(found.owner, async (db) => {
    const { view, versionId } = await loadIn(db, found.owner, found.row);
    if (view.state === "withdrawn" || view.state === "replaced") throw new CrmError("not_found", stateMessage(view.state), 404);
    const file = await db.query<{ data: Buffer; title: string }>(
      "select f.data, d.title from crm.document_files f join crm.documents d on d.id = f.document_id where f.version_id = $1 and f.kind = $2",
      [versionId, kind],
    );
    if (!file.rows[0]) throw new CrmError("not_found", kind === "executed" ? "The signed copy is ready once both sides have signed." : "PDF not found.", 404);
    if (meta.track) {
      await logEvent(db, { workspaceId: found.owner.workspaceId, documentId: found.row.document_id, versionId, type: kind === "executed" ? "downloaded_signed" : "downloaded", actor: "client" });
    }
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
    case "updating":
      return "This is being updated. Check back shortly.";
    default:
      return "";
  }
}

export async function publicKnowledgeFile(token: string, itemId: string, meta: Meta & { track: boolean }) {
  const found = await resolve(token);
  if (!found) throw new CrmError("not_found", "This link isn't valid.", 404);
  const { row, view, versionId, content } = await load(found.owner, found.row);
  if (view.state === "withdrawn" || view.state === "replaced") throw new CrmError("not_found", stateMessage(view.state), 404);
  const listed = content.blocks.flatMap((block) => (block.type === "documents" ? block.items : [])).find((item) => item.id === itemId);
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
  if (listed.fingerprint && item.content !== null && createHash("sha256").update(item.content, "utf8").digest("hex") !== listed.fingerprint) {
    throw new CrmError("conflict", `${listed.title} has changed since this was sent. Ask ${view.content.sender.name} for the current copy.`, 409);
  }
  if (meta.track) {
    await scheduleAlert(
      found.owner,
      {
        key: `doc-file:${row.id}:${itemId}:${Math.floor(Date.now() / VIEW_ALERT_GAP_MS)}`,
        title: `${row.contact_name ?? "Your contact"} opened ${item.title}`,
        body: `In ${row.title}, ${row.company_name}.`,
        href: documentHref(row.id),
      },
      meta.push,
    );
  }
  if (item.file_path) {
    const data = await readObject(item.file_path, fetch, "knowledge");
    const name = item.file_path.split("/").pop() ?? item.title;
    return { kind: "file" as const, data, name, contentType: item.mime_type ?? "application/octet-stream" };
  }
  if (item.source_url) return { kind: "link" as const, url: item.source_url };
  return { kind: "file" as const, data: new TextEncoder().encode(item.content ?? ""), name: `${item.title}.txt`, contentType: "text/plain; charset=utf-8" };
}

export async function clientStep(token: string, stepId: string, input: { done?: unknown }, meta: Meta = {}) {
  const found = await resolve(token);
  if (!found) throw new CrmError("not_found", "This link isn't valid.", 404);
  const done = input.done === true;
  const changed = await withActor(found.owner, async (db) => {
    const { row, view, versionId } = await loadIn(db, found.owner, found.row);
    if (view.state === "withdrawn" || view.state === "replaced") throw new CrmError("conflict", stateMessage(view.state), 409);
    const step = view.steps.find((item) => item.id === stepId);
    if (!step) throw new CrmError("not_found", "That step isn't on this plan.", 404);
    if (step.side !== "client") throw new CrmError("invalid_input", `${view.content.sender.company} ticks off its own steps.`, 400);
    if (Boolean(step.doneAt) === done) return null;
    if (done) await db.query("update crm.document_steps set done_at = now(), done_by = 'client', done_name = $2 where id = $1", [stepId, view.content.client.name.slice(0, 200)]);
    else await db.query("update crm.document_steps set done_at = null, done_by = null, done_name = null where id = $1", [stepId]);
    await logEvent(db, {
      workspaceId: found.owner.workspaceId,
      documentId: row.id,
      versionId,
      type: done ? "step_done" : "step_reopened",
      actor: "client",
      name: view.content.client.name,
      email: view.content.client.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
      data: { stepId, title: step.title },
    });
    await recordAudit(db, found.owner, "document.steps_changed", "document", row.id, { operation: done ? "client_step_done" : "client_step_reopened", source: "proposal_page" }, { step: step.title, done });
    return { row, step };
  });
  if (changed && done) {
    await scheduleAlert(
      found.owner,
      {
        key: `doc-step:${changed.row.id}:${stepId}:${Math.floor(Date.now() / VIEW_ALERT_GAP_MS)}`,
        title: `${changed.row.contact_name ?? "Your contact"} completed ${changed.step.title}`,
        body: `${changed.row.title}, ${changed.row.company_name}.`,
        href: documentHref(changed.row.id),
      },
      meta.push,
    );
  }
  return (await openDocument(token, { track: false }))!;
}

export async function recordReading(token: string, input: unknown, meta: Meta = {}) {
  const tabs = (input as { tabs?: unknown } | null)?.tabs;
  if (!tabs || typeof tabs !== "object" || Array.isArray(tabs)) throw new CrmError("invalid_input", "Nothing to record.", 400);
  const found = await resolve(token);
  if (!found) throw new CrmError("not_found", "This link isn't valid.", 404);
  const { row, view, versionId, content } = await load(found.owner, found.row);
  if (view.state === "withdrawn" || view.state === "replaced") return { recorded: false };
  const known = new Set(["Sign", ...(tabsOf(content.blocks)?.map((tab) => tab.label) ?? ["Proposal"])]);
  const clean = new Map<string, number>();
  for (const [label, seconds] of Object.entries(tabs as Record<string, unknown>).slice(0, READING_TABS_MAX)) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) continue;
    const name = label.replace(/\s+/g, " ").trim();
    if (known.has(name)) clean.set(name, Math.min(READING_SECONDS_MAX, Math.round(seconds)));
  }
  const total = [...clean.values()].reduce((sum, value) => sum + value, 0);
  if (total < 3) return { recorded: false };
  await withActor(found.owner, (db) =>
    logEvent(db, {
      workspaceId: found.owner.workspaceId,
      documentId: row.id,
      versionId,
      type: "reading",
      actor: "client",
      name: view.content.client.name,
      email: view.content.client.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
      data: { tabs: Object.fromEntries(clean), seconds: total },
    }),
  );
  return { recorded: true };
}
