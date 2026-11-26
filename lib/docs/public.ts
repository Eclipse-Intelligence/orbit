import { query } from "@/lib/db/pool";
import { renderDocPdf } from "@/lib/docs/pdf";
import { decryptSecret } from "@/lib/crypto/secret";
import { publicPath } from "@/lib/docs/public-link";

export type PublicDoc = { title: string; content: string; updatedAt: string; allowDownload: boolean; expiresAt: string | null; redirectTo: string | null };

type PublicRow = {
  title: string;
  content: string;
  edited_at: Date;
  allow_download: boolean;
  expires_at: Date | null;
  public_slug: string | null;
  forward_token_enc: string | null;
};

const LINK_SHAPE = /^[A-Za-z0-9_-]{3,64}$/;

function redirectOf(value: string, row: PublicRow) {
  if (row.public_slug) return value === row.public_slug ? null : publicPath(row.public_slug);
  return row.forward_token_enc ? publicPath(decryptSecret(row.forward_token_enc)) : null;
}

export async function openPublicDoc(value: string): Promise<PublicDoc | null> {
  if (!LINK_SHAPE.test(value)) return null;
  const result = await query<PublicRow>("select * from private.public_page_link($1)", [value]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    title: row.title.trim() || "Untitled",
    content: row.content,
    updatedAt: row.edited_at.toISOString(),
    allowDownload: row.allow_download,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    redirectTo: redirectOf(value, row),
  };
}

function asciiName(title: string) {
  const slug = title
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug || "document"}.pdf`;
}

function encodedName(title: string) {
  const clean = title.replace(/[\u0000-\u001f\u007f/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "document";
  return encodeURIComponent(`${clean}.pdf`).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function pdfDisposition(title: string) {
  return `attachment; filename="${asciiName(title)}"; filename*=UTF-8''${encodedName(title)}`;
}

export async function publicDocPdf(link: string) {
  const doc = await openPublicDoc(link);
  if (!doc || !doc.allowDownload) return null;
  return { data: await renderDocPdf(doc), disposition: pdfDisposition(doc.title) };
}
