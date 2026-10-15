import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { CrmError } from "@/lib/crm/errors";
import {
  copyName,
  matchesTemplate,
  templateTagCounts,
  unpersonalised,
} from "@/lib/crm/email-template-rules";
import {
  archiveEmailTemplate,
  createEmailTemplate,
  deleteEmailTemplate,
  duplicateEmailTemplate,
  getEmailTemplate,
  listEmailTemplates,
  listTemplateTags,
  renderTemplate,
  SAMPLE_RECIPIENT,
  updateEmailTemplate,
} from "@/lib/crm/email-templates";
import { contactRecipient, type Recipient } from "@/lib/crm/personalise";
import type { UserActor } from "@/lib/crm/types";
import {
  legacySettingsHref,
  SETTINGS_PATHS,
  settingsHashTarget,
  settingsRedirect,
} from "@/lib/settings-nav";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

let owner: UserActor;
let outsider: UserActor;

before(async () => {
  await resetDatabase();
  owner = await createUser("templates@orbit-templates.test", "Template Owner");
  outsider = await createUser("outsider@orbit-templates.test", "Outsider");
});

after(async () => {
  await getPool().end();
});

function code(expected: string, message?: RegExp) {
  return (error: unknown) => {
    assert.ok(
      error instanceof CrmError,
      `expected a CrmError, got ${String(error)}`,
    );
    assert.equal(error.code, expected);
    if (message) assert.match(error.message, message);
    return true;
  };
}

async function clear() {
  await getAdminPool().query("delete from crm.email_templates");
}

const jane: Recipient = {
  id: "jane",
  firstName: "Jane",
  lastName: "Doe",
  name: "Jane Doe",
  email: "jane@acme.test",
  company: "Acme",
};

describe("email template rules", () => {
  it("renders the personal tokens for a recipient and leaves unknown ones", () => {
    const rendered = renderTemplate(
      {
        subject: "Hello {{ first_name }} from {{company}}",
        body: "Hi {{first_name}} {{last_name}},\n\n{{name}} at {{company}}.\n{{unknown}}",
      },
      jane,
    );
    assert.equal(rendered.subject, "Hello Jane from Acme");
    assert.equal(
      rendered.body,
      "Hi Jane Doe,\n\nJane Doe at Acme.\n{{unknown}}",
    );
    const nameless = renderTemplate(
      { subject: "{{first_name}}", body: "{{name}}|{{company}}" },
      { ...jane, firstName: null, lastName: null, company: null },
    );
    assert.deepEqual(nameless, { subject: "there", body: "there|" });
    assert.equal(
      renderTemplate({ subject: "{{company}}", body: "" }, SAMPLE_RECIPIENT)
        .subject,
      "Example Ltd",
    );
  });

  it("builds a recipient from a contact", () => {
    assert.deepEqual(
      contactRecipient({
        id: "c1",
        firstName: "Jane",
        lastName: "Doe",
        name: "Jane Doe",
        email: "jane@acme.test",
        companyName: "Acme",
      }),
      { ...jane, id: "c1" },
    );
  });

  it("keeps the template text for fields left as the template rendered them", () => {
    const source = { subject: "Hi {{first_name}}", body: "Hello {{name}}" };
    const rendered = renderTemplate(source, jane);
    assert.deepEqual(unpersonalised(rendered, { source, rendered }), source);
    assert.deepEqual(
      unpersonalised(
        { subject: rendered.subject, body: "Edited" },
        { source, rendered },
      ),
      { subject: "Hi {{first_name}}", body: "Edited" },
    );
    assert.deepEqual(unpersonalised({ subject: "a", body: "b" }, null), {
      subject: "a",
      body: "b",
    });
  });

  it("matches search text and tags, and counts tags", () => {
    const template = {
      name: "Intro",
      subject: "Great to meet",
      body: "Next steps",
      tags: ["sales"],
    };
    assert.equal(matchesTemplate(template, "", null), true);
    assert.equal(matchesTemplate(template, "great", null), true);
    assert.equal(matchesTemplate(template, "STEPS", "Sales "), true);
    assert.equal(matchesTemplate(template, "", "support"), false);
    assert.equal(matchesTemplate(template, "missing", null), false);
    assert.deepEqual(
      templateTagCounts([{ tags: ["b", "a"] }, { tags: ["a"] }]),
      [
        { name: "a", templates: 2 },
        { name: "b", templates: 1 },
      ],
    );
  });

  it("finds a free copy name and keeps it within the limit", () => {
    assert.equal(copyName("Intro", []), "Copy of Intro");
    assert.equal(copyName("Intro", ["copy of intro"]), "Copy of Intro (2)");
    assert.equal(
      copyName("Intro", ["Copy of Intro", "Copy of Intro (2)"]),
      "Copy of Intro (3)",
    );
    const long = copyName("x".repeat(120), ["Copy of " + "x".repeat(112)]);
    assert.equal(long.length, 120);
    assert.match(long, / \(2\)$/);
  });
});

describe("email templates", () => {
  it("creates a template with normalised name, subject, body and tags", async () => {
    await clear();
    const template = await createEmailTemplate(owner, {
      name: "  Intro   follow-up ",
      subject: "  Great to meet you,\n{{first_name}} ",
      body: "\n\nHi {{first_name}},\r\n\r\n  Thanks for today.\n\nBest\n\n",
      tags: [" Sales ", "sales", "Follow Up", ""],
    });
    assert.equal(template.name, "Intro follow-up");
    assert.equal(template.subject, "Great to meet you, {{first_name}}");
    assert.equal(
      template.body,
      "Hi {{first_name}},\n\n  Thanks for today.\n\nBest",
    );
    assert.deepEqual(template.tags, ["sales", "follow up"]);
    assert.equal(template.createdBy, owner.userId);
    assert.equal(template.archivedAt, null);
    assert.deepEqual(await getEmailTemplate(owner, template.id), template);
  });

  it("explains invalid input", async () => {
    await assert.rejects(
      createEmailTemplate(owner, { name: "  ", body: "x" }),
      code("invalid_input", /name/),
    );
    await assert.rejects(
      createEmailTemplate(owner, { name: "x".repeat(121), body: "x" }),
      code("invalid_input", /120 characters/),
    );
    await assert.rejects(
      createEmailTemplate(owner, {
        name: "Long subject",
        subject: "s".repeat(301),
      }),
      code("invalid_input", /300 characters/),
    );
    await assert.rejects(
      createEmailTemplate(owner, {
        name: "Long body",
        body: "b".repeat(20001),
      }),
      code("invalid_input", /20,000 characters/),
    );
    await assert.rejects(
      createEmailTemplate(owner, { name: "Empty", subject: " ", body: "\n" }),
      code("invalid_input", /subject or a message/),
    );
    await assert.rejects(
      createEmailTemplate(owner, {
        name: "Tagged",
        body: "x",
        tags: Array.from({ length: 21 }, (_, index) => `tag ${index}`),
      }),
      code("invalid_input", /template can have at most 20 tags/),
    );
    await assert.rejects(
      createEmailTemplate(owner, {
        name: "Tagged",
        body: "x",
        tags: ["t".repeat(41)],
      }),
      code("invalid_input", /40 characters/),
    );
    await assert.rejects(
      createEmailTemplate(owner, { name: "Tagged", body: "x", tags: ["a;b"] }),
      code("invalid_input", /semicolon/),
    );
    await assert.rejects(
      createEmailTemplate(owner, {
        name: "Tagged",
        body: "x",
        tags: "sales" as unknown as string[],
      }),
      code("invalid_input", /Tags must be text/),
    );
    const exact = await createEmailTemplate(owner, {
      name: "n".repeat(120),
      subject: "s".repeat(300),
      body: "b".repeat(20000),
      tags: Array.from({ length: 20 }, (_, index) => `tag ${index}`),
    });
    assert.equal(exact.body.length, 20000);
  });

  it("keeps names unique per workspace, ignoring case, among live templates", async () => {
    await clear();
    const first = await createEmailTemplate(owner, {
      name: "Pricing",
      body: "One",
    });
    await assert.rejects(
      createEmailTemplate(owner, { name: "  PRICING ", body: "Two" }),
      code("duplicate", /“PRICING” already exists/),
    );
    const other = await createEmailTemplate(owner, {
      name: "Pricing v2",
      body: "Two",
    });
    await assert.rejects(
      updateEmailTemplate(owner, other.id, { name: "pricing" }),
      code("duplicate"),
    );
    const theirs = await createEmailTemplate(outsider, {
      name: "Pricing",
      body: "Theirs",
    });
    assert.equal(theirs.name, "Pricing");
    await archiveEmailTemplate(owner, first.id);
    const reused = await createEmailTemplate(owner, {
      name: "pricing",
      body: "Again",
    });
    assert.equal(reused.name, "pricing");
  });

  it("updates only the fields sent", async () => {
    await clear();
    const template = await createEmailTemplate(owner, {
      name: "Check in",
      subject: "Checking in",
      body: "Hi {{first_name}}",
      tags: ["nurture"],
    });
    const renamed = await updateEmailTemplate(owner, template.id, {
      name: "Quarterly check in",
    });
    assert.equal(renamed.name, "Quarterly check in");
    assert.equal(renamed.subject, "Checking in");
    assert.deepEqual(renamed.tags, ["nurture"]);
    assert.ok(renamed.updatedAt >= template.updatedAt);
    const retagged = await updateEmailTemplate(owner, template.id, {
      tags: ["Nurture", "Q3"],
    });
    assert.deepEqual(retagged.tags, ["nurture", "q3"]);
    const cleared = await updateEmailTemplate(owner, template.id, {
      subject: "",
    });
    assert.equal(cleared.subject, "");
    await assert.rejects(
      updateEmailTemplate(owner, template.id, { body: " " }),
      code("invalid_input", /subject or a message/),
    );
    await assert.rejects(
      updateEmailTemplate(owner, template.id, { name: "" }),
      code("invalid_input"),
    );
    await assert.rejects(
      updateEmailTemplate(owner, "not-a-uuid", { name: "x" }),
      code("not_found"),
    );
  });

  it("duplicates with a unique copy name and the same content", async () => {
    await clear();
    const template = await createEmailTemplate(owner, {
      name: "Intro",
      subject: "Hello {{first_name}}",
      body: "Body",
      tags: ["sales"],
    });
    const copy = await duplicateEmailTemplate(owner, template.id);
    assert.equal(copy.name, "Copy of Intro");
    assert.equal(copy.subject, template.subject);
    assert.equal(copy.body, template.body);
    assert.deepEqual(copy.tags, template.tags);
    assert.notEqual(copy.id, template.id);
    const second = await duplicateEmailTemplate(owner, template.id);
    assert.equal(second.name, "Copy of Intro (2)");
    const ofCopy = await duplicateEmailTemplate(owner, copy.id);
    assert.equal(ofCopy.name, "Copy of Copy of Intro");
  });

  it("searches name, subject and body, filters by tag, and lists newest first", async () => {
    await clear();
    const intro = await createEmailTemplate(owner, {
      name: "Intro",
      subject: "Great to meet",
      body: "Let's talk pricing_100%",
      tags: ["sales"],
    });
    const renewal = await createEmailTemplate(owner, {
      name: "Renewal",
      subject: "Your renewal",
      body: "Hi",
      tags: ["sales", "customers"],
    });
    const support = await createEmailTemplate(owner, {
      name: "Support reply",
      subject: "Re: your question",
      body: "Thanks for asking",
      tags: ["support"],
    });
    const names = (rows: { name: string }[]) => rows.map((row) => row.name);
    assert.deepEqual(names(await listEmailTemplates(owner)), [
      "Support reply",
      "Renewal",
      "Intro",
    ]);
    await updateEmailTemplate(owner, intro.id, {
      subject: "Great to meet you",
    });
    assert.deepEqual(names(await listEmailTemplates(owner)), [
      "Intro",
      "Support reply",
      "Renewal",
    ]);
    assert.equal(support.name, "Support reply");
    assert.deepEqual(
      names(await listEmailTemplates(owner, { search: "RENEW" })),
      ["Renewal"],
    );
    assert.deepEqual(
      names(await listEmailTemplates(owner, { search: "question" })),
      ["Support reply"],
    );
    assert.deepEqual(
      names(await listEmailTemplates(owner, { search: "for ask" })),
      ["Support reply"],
    );
    assert.deepEqual(
      names(await listEmailTemplates(owner, { search: "_100%" })),
      ["Intro"],
    );
    assert.deepEqual(names(await listEmailTemplates(owner, { search: "%" })), [
      "Intro",
    ]);
    assert.deepEqual(
      names(await listEmailTemplates(owner, { tag: " Sales " })),
      ["Intro", "Renewal"],
    );
    assert.deepEqual(
      names(
        await listEmailTemplates(owner, { tag: "sales", search: "renewal" }),
      ),
      ["Renewal"],
    );
    assert.deepEqual(await listEmailTemplates(owner, { tag: "nothing" }), []);
    assert.deepEqual(await listTemplateTags(owner), [
      { name: "customers", templates: 1 },
      { name: "sales", templates: 2 },
      { name: "support", templates: 1 },
    ]);
    await archiveEmailTemplate(owner, renewal.id);
    assert.deepEqual(names(await listEmailTemplates(owner)), [
      "Intro",
      "Support reply",
    ]);
    assert.deepEqual(await listTemplateTags(owner), [
      { name: "sales", templates: 1 },
      { name: "support", templates: 1 },
    ]);
  });

  it("archives and deletes", async () => {
    await clear();
    const template = await createEmailTemplate(owner, {
      name: "Old",
      body: "x",
    });
    const archived = await archiveEmailTemplate(owner, template.id);
    assert.ok(archived.archivedAt);
    await assert.rejects(
      getEmailTemplate(owner, template.id),
      code("not_found"),
    );
    await assert.rejects(
      archiveEmailTemplate(owner, template.id),
      code("not_found"),
    );
    await assert.rejects(
      duplicateEmailTemplate(owner, template.id),
      code("not_found"),
    );
    const live = await createEmailTemplate(owner, { name: "Live", body: "x" });
    assert.deepEqual(await deleteEmailTemplate(owner, live.id), {
      id: live.id,
    });
    await assert.rejects(
      deleteEmailTemplate(owner, live.id),
      code("not_found"),
    );
    await assert.rejects(deleteEmailTemplate(owner, "nope"), code("not_found"));
    const rows = await getAdminPool().query(
      "select id from crm.email_templates where id = $1",
      [live.id],
    );
    assert.equal(rows.rowCount, 0);
  });

  it("keeps templates inside the workspace", async () => {
    await clear();
    const mine = await createEmailTemplate(owner, {
      name: "Mine",
      body: "secret",
      tags: ["private"],
    });
    assert.deepEqual(await listEmailTemplates(outsider), []);
    assert.deepEqual(await listTemplateTags(outsider), []);
    await assert.rejects(
      getEmailTemplate(outsider, mine.id),
      code("not_found"),
    );
    await assert.rejects(
      updateEmailTemplate(outsider, mine.id, { name: "Stolen" }),
      code("not_found"),
    );
    await assert.rejects(
      duplicateEmailTemplate(outsider, mine.id),
      code("not_found"),
    );
    await assert.rejects(
      archiveEmailTemplate(outsider, mine.id),
      code("not_found"),
    );
    await assert.rejects(
      deleteEmailTemplate(outsider, mine.id),
      code("not_found"),
    );
    assert.equal((await getEmailTemplate(owner, mine.id)).name, "Mine");

    const seen = await queryAsUser<{ total: number }>(
      outsider.userId,
      "select count(*)::int as total from crm.email_templates",
    );
    assert.equal(seen[0].total, 0);
    const changed = await queryAsUser(
      outsider.userId,
      "update crm.email_templates set name = 'Stolen' returning id",
    );
    assert.equal(changed.length, 0);
    const removed = await queryAsUser(
      outsider.userId,
      "delete from crm.email_templates returning id",
    );
    assert.equal(removed.length, 0);
    await assert.rejects(
      queryAsUser(
        outsider.userId,
        "insert into crm.email_templates (workspace_id, created_by, name, body) values ($1, $2, 'Sneaky', 'x')",
        [owner.workspaceId, outsider.userId],
      ),
      /row-level security/,
    );
    await assert.rejects(
      queryAsUser(
        owner.userId,
        "insert into crm.email_templates (workspace_id, created_by, name, body) values ($1, $2, 'Forged', 'x')",
        [owner.workspaceId, outsider.userId],
      ),
      /row-level security/,
    );
    await assert.rejects(
      queryAsUser(
        owner.userId,
        "update crm.email_templates set workspace_id = $1 returning id",
        [outsider.workspaceId],
      ),
      /permission denied/,
    );
  });

  it("lets workspace teammates share templates", async () => {
    await clear();
    const teammate = await createUser(
      "teammate@orbit-templates.test",
      "Teammate",
    );
    await getAdminPool().query(
      "insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
      [owner.workspaceId, teammate.userId],
    );
    const shared = await createEmailTemplate(owner, {
      name: "Shared",
      body: "x",
    });
    const rows = await queryAsUser<{ name: string }>(
      teammate.userId,
      "select name from crm.email_templates where workspace_id = $1",
      [owner.workspaceId],
    );
    assert.deepEqual(rows, [{ name: "Shared" }]);
    const edited = await queryAsUser<{ name: string }>(
      teammate.userId,
      "update crm.email_templates set name = 'Shared edit' where id = $1 returning name",
      [shared.id],
    );
    assert.deepEqual(edited, [{ name: "Shared edit" }]);
    await getAdminPool().query(
      "delete from crm.workspace_members where workspace_id = $1 and user_id = $2",
      [owner.workspaceId, teammate.userId],
    );
  });

  it("gives agents and anonymous visitors no access", async () => {
    await clear();
    await createEmailTemplate(owner, { name: "Agentless", body: "x" });
    for (const role of ["crm_agent", "anon"]) {
      const client = await getAdminPool().connect();
      try {
        await client.query("begin");
        await client.query("select set_config('app.workspace_id', $1, true)", [
          owner.workspaceId,
        ]);
        await client.query(`set local role ${role}`);
        await assert.rejects(
          client.query("select id from crm.email_templates"),
          /permission denied/,
        );
      } finally {
        await client.query("rollback");
        client.release();
      }
    }
  });
});

describe("settings routes", () => {
  it("sends old settings anchors to the matching page", () => {
    assert.equal(settingsHashTarget("#calendars"), SETTINGS_PATHS.calendars);
    assert.equal(settingsHashTarget("#Pipeline"), SETTINGS_PATHS.pipeline);
    assert.equal(settingsHashTarget("tags"), SETTINGS_PATHS.tags);
    assert.equal(settingsHashTarget("#webhooks"), SETTINGS_PATHS.api);
    assert.equal(settingsHashTarget("#clickup"), SETTINGS_PATHS.integrations);
    assert.equal(
      settingsHashTarget("#email-templates"),
      SETTINGS_PATHS.emailTemplates,
    );
    assert.equal(settingsHashTarget("#meeting-link"), null);
    assert.equal(settingsHashTarget(""), null);
    assert.equal(settingsHashTarget("#constructor"), null);
    assert.equal(settingsHashTarget("#%E0%A4%A"), null);
  });

  it("redirects /settings to General and keeps calendar connection results", () => {
    const query = (value: string) => new URLSearchParams(value);
    assert.equal(
      legacySettingsHref("/settings", query("")),
      SETTINGS_PATHS.general,
    );
    assert.equal(
      legacySettingsHref("/settings/", query("a=1&b=2&b=3")),
      `${SETTINGS_PATHS.general}?a=1&b=2&b=3`,
    );
    assert.equal(
      legacySettingsHref(
        "/settings",
        query("calendar_connected=me%40example.com"),
      ),
      `${SETTINGS_PATHS.calendars}?calendar_connected=me%40example.com`,
    );
    assert.equal(
      settingsRedirect(query("calendar_error=Nope")),
      `${SETTINGS_PATHS.calendars}?calendar_error=Nope`,
    );
    assert.equal(legacySettingsHref("/settings/general", query("")), null);
    assert.equal(legacySettingsHref("/settingsx", query("")), null);
  });
});
