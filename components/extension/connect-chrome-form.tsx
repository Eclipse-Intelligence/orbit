"use client";

import { useId, useState, useTransition } from "react";
import { decideExtensionAction } from "@/app/connect/chrome/actions";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Input } from "@/components/_ui/input";
import WorkspaceTile from "@/components/workspaces/workspace-tile";

type Workspace = { id: string; name: string };

function WorkspaceChoice({ workspace, checked, onChange }: { workspace: Workspace; checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId();
  return (
    <label htmlFor={id} className="border-border flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <WorkspaceTile id={workspace.id} name={workspace.name} />
      <span className="text-[14px] leading-5">{workspace.name}</span>
    </label>
  );
}

export default function ConnectChromeForm({ code, suggestedName, workspaces }: { code: string; suggestedName: string; workspaces: Workspace[] }) {
  const nameId = useId();
  const [name, setName] = useState(suggestedName);
  const [chosen, setChosen] = useState<string[]>(workspaces.map((workspace) => workspace.id));
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"approved" | "declined" | null>(null);
  const [pending, start] = useTransition();

  function decide(approve: boolean) {
    setError(null);
    start(async () => {
      const result = await decideExtensionAction({ code, name, workspaceIds: chosen, approve });
      if (result.error) setError(result.error);
      else setDone(approve ? "approved" : "declined");
    });
  }

  if (done) {
    return (
      <div role="status" className="border-sidebar-border bg-sidebar-accent flex flex-col gap-2 rounded-xl border p-5">
        <h2 className="leading-6">{done === "approved" ? "Connected" : "Cancelled"}</h2>
        <p className="text-subtle text-[14px] leading-5">
          {done === "approved"
            ? "Go back to LinkedIn. The extension finishes connecting by itself, and you can close this tab."
            : "Nothing was connected. You can close this tab."}
        </p>
      </div>
    );
  }

  return (
    <form
      className="border-sidebar-border bg-sidebar-accent flex flex-col gap-5 rounded-xl border p-5"
      onSubmit={(event) => {
        event.preventDefault();
        decide(true);
      }}
    >
      <div className="flex flex-col gap-2">
        <span className="caption-style text-soft">Code shown in the extension</span>
        <span className="font-mono text-[20px] leading-none tracking-[0.12em]">{code}</span>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor={nameId} className="caption-style text-soft">
          Name
        </label>
        <Input id={nameId} value={name} maxLength={120} required onChange={(event) => setName(event.target.value)} />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="caption-style text-soft mb-2">Workspaces</legend>
        {workspaces.map((workspace) => (
          <WorkspaceChoice
            key={workspace.id}
            workspace={workspace}
            checked={chosen.includes(workspace.id)}
            onChange={(checked) =>
              setChosen((current) => (checked ? [...current, workspace.id] : current.filter((id) => id !== workspace.id)))
            }
          />
        ))}
      </fieldset>
      <div className="caption-style text-subtle flex flex-col gap-1.5 leading-[1.4]">
        <span>It can look up and save people and companies, and add tasks, notes and LinkedIn activity.</span>
        <span>It can&apos;t read your mail, calendars, docs or assistant chats.</span>
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger leading-[1.4]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="md" disabled={pending} onClick={() => decide(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="md" disabled={pending || chosen.length === 0 || !name.trim()}>
          Approve
        </Button>
      </div>
    </form>
  );
}
