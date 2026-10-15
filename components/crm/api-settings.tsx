import { SettingsCard, SettingsDisclosure } from "@/components/crm/settings-ui";

function Code({ children }: { children: string }) {
  return (
    <code className="bg-secondary border-border rounded-md border px-1.5 py-0.5 font-mono text-[12px] leading-5 wrap-anywhere">
      {children}
    </code>
  );
}

export default function ApiSettings({
  origin,
  scopes,
}: {
  origin: string;
  scopes: string[];
}) {
  return (
    <SettingsCard
      id="agents"
      title="Agents and API tokens"
      description="Agents use a token to read and update Orbit over REST or MCP. Each token is limited to the scopes it was issued with."
    >
      <dl className="flex flex-col">
        <div className="border-border flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b pb-3">
          <dt className="caption-style text-subtle">REST API</dt>
          <dd>
            <Code>{`${origin}/api/v1`}</Code>
          </dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 pt-3">
          <dt className="caption-style text-subtle">MCP server</dt>
          <dd>
            <Code>{`${origin}/api/mcp`}</Code>
          </dd>
        </div>
      </dl>
      <SettingsDisclosure
        title="Issue and revoke tokens"
        summary="Tokens are created from the command line and shown once."
      >
        <p className="caption-style text-subtle leading-[1.4]">
          Run this where Orbit&apos;s database variables are set:
        </p>
        <pre className="bg-secondary border-border overflow-x-auto rounded-lg border px-3 py-2 font-mono text-[12px] leading-5">
          {'npm run agent:create -- --name "Research" --scopes crm:read,companies:write'}
        </pre>
        <p className="caption-style text-subtle leading-[1.4]">
          Send it as <Code>Authorization: Bearer crm_…</Code>. Each token can
          make 120 requests a minute. To revoke one, set <Code>revoked_at</Code>{" "}
          on its row in <Code>crm.agent_credentials</Code>.
        </p>
      </SettingsDisclosure>
      <SettingsDisclosure
        title="Scopes"
        summary={`${scopes.length} scopes. admin includes all of them.`}
      >
        <ul className="flex flex-wrap gap-1.5">
          {scopes.map((scope) => (
            <li key={scope}>
              <Code>{scope}</Code>
            </li>
          ))}
        </ul>
      </SettingsDisclosure>
      <SettingsDisclosure
        title="Filing email and meetings"
        summary="How agents add conversations to a contact."
      >
        <p className="caption-style text-subtle leading-[1.4]">
          Agents file emails and meetings with record_email and record_meeting.
          Orbit matches the person by email and the company by domain, then
          suggests a follow-up task when the company has no open task. To file
          Outlook mail automatically and send from a contact, connect Microsoft
          in Inbox.
        </p>
      </SettingsDisclosure>
    </SettingsCard>
  );
}
