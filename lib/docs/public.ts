import { query } from "@/lib/db/pool";
import { hashPublicToken, isPublicToken } from "@/lib/docs/public-link";
import { renderDocPdf } from "@/lib/docs/pdf";

export type PublicDoc = { title: string; content: string; updatedAt: string; allowDownload: boolean };

type PublicRow = { title: string; content: string; edited_at: Date; allow_download: boolean };

export async function openPublicDoc(token: string): Promise<PublicDoc | null> {
  if (!isPublicToken(token)) return null;
  const result = await query<PublicRow>("select * from private.public_page($1)", [hashPublicToken(token)]);
  const row = result.rows[0];
  if (!row) return null;
  return { title: row.title.trim() || "Untitled", content: row.content, updatedAt: row.edited_at.toISOString(), allowDownload: row.allow_download };
}

function fileName(title: string) {
  const slug = title
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug || "document"}.pdf`;
}

export async function publicDocPdf(token: string) {
  const doc = await openPublicDoc(token);
  if (!doc || !doc.allowDownload) return null;
  return { data: await renderDocPdf(doc), filename: fileName(doc.title) };
}
