import { withActor } from "@/lib/crm/context";
import { CrmError, notFound, tooMany } from "@/lib/crm/errors";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";

const OTHER_EMAILS_LIMIT = 20;

export type MyEmails = { loginEmail: string; otherEmails: string[] };

type ProfileRow = { email: string | null; other_emails: string[] | null };

function mapEmails(actor: UserActor, row: ProfileRow | undefined): MyEmails {
  return {
    loginEmail: row?.email ?? actor.email,
    otherEmails: row?.other_emails ?? [],
  };
}

export function cleanOtherEmails(values: unknown, loginEmail: string) {
  if (!Array.isArray(values)) {
    throw new CrmError("invalid_input", "Invalid email addresses.", 400, { field: "otherEmails" });
  }
  const login = canonicalEmail(loginEmail);
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const email = canonicalEmail(value);
    if (!email) {
      throw new CrmError("invalid_input", `“${value.trim().slice(0, 80)}” isn't a valid email address.`, 400, {
        field: "otherEmails",
      });
    }
    if (email !== login) seen.add(email);
  }
  if (seen.size > OTHER_EMAILS_LIMIT) {
    throw new CrmError(
      "invalid_input",
      tooMany(OTHER_EMAILS_LIMIT, "other email addresses"),
      400,
      { field: "otherEmails" },
    );
  }
  return [...seen];
}

export async function getMyEmails(actor: UserActor): Promise<MyEmails> {
  return withActor(actor, async (db) => {
    const result = await db.query<ProfileRow>(
      "select email, other_emails from crm.profiles where id = $1",
      [actor.userId],
    );
    return mapEmails(actor, result.rows[0]);
  });
}

export async function saveOtherEmails(actor: UserActor, values: unknown): Promise<MyEmails> {
  return withActor(actor, async (db) => {
    const current = await db.query<ProfileRow>(
      "select email, other_emails from crm.profiles where id = $1 for update",
      [actor.userId],
    );
    if (!current.rows[0]) throw notFound("profile");
    const otherEmails = cleanOtherEmails(values, current.rows[0].email ?? actor.email);
    const saved = await db.query<ProfileRow>(
      "update crm.profiles set other_emails = $2::text[] where id = $1 returning email, other_emails",
      [actor.userId, otherEmails],
    );
    return mapEmails(actor, saved.rows[0]);
  });
}
