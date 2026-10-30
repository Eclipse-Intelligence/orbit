import CopyButton from "@/components/_ui/copy-button";
import { SettingsCard } from "@/components/crm/settings-ui";

function Code({ children, long = false }: { children: string; long?: boolean }) {
  return <code className={`bg-secondary rounded-md px-1.5 py-0.5 font-mono text-[12px] leading-5 ${long ? "break-all" : "whitespace-nowrap"}`}>{children}</code>;
}

export default function IphoneShortcutSettings({ origin }: { origin: string }) {
  const url = `${origin}/api/quick`;
  return (
    <SettingsCard
      id="iphone-shortcut"
      title="iPhone Shortcut"
      description="Add to today's daily note or make a task from your Home Screen, Lock Screen, Control Center, the Action Button or Siri, without opening Orbit."
    >
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-[14px] leading-5">
        <li>Create a personal token above called iPhone Shortcut and copy it.</li>
        <li>
          In the Shortcuts app, make a new shortcut called Add to Orbit and add these actions:
          <ul className="text-soft mt-2 flex list-disc flex-col gap-2 pl-5">
            <li>Ask for Input, Text. Use Dictate Text instead if you&apos;d rather speak.</li>
            <li>
              <span className="flex flex-wrap items-center gap-2">
                Get Contents of URL with <Code long>{url}</Code>
                <CopyButton text={url} label="Copy URL" />
              </span>
              <span className="mt-1 block">
                Method POST. Header <Code>Authorization</Code> set to <Code>Bearer</Code> followed by a space and your token. Request Body JSON with <Code>text</Code> set to
                the Provided Input and <Code>to</Code> set to <Code>daily</Code>.
              </span>
            </li>
            <li>Show Result, so you see what Orbit added.</li>
          </ul>
        </li>
        <li>
          For tasks, duplicate it as New Orbit task and set <Code>to</Code> to <Code>task</Code>. The first line becomes the task and the rest its description.
        </li>
        <li>Add either shortcut to your Home Screen, a Shortcuts widget, Control Center, the Lock Screen or the Action Button, or say &quot;Add to Orbit&quot; to Siri.</li>
      </ol>
      <p className="caption-style text-subtle">The token can read your Orbit and your mail, so only keep it in your own shortcuts. Revoke it above if your phone is lost.</p>
    </SettingsCard>
  );
}
