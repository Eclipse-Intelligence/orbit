"use client";

import { useId, useState, useTransition } from "react";
import { revokeBrowserAction, setBrowserWorkspacesAction } from "@/app/(crm)/settings/extension";
import Button, { buttonVariants } from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import HoldButton from "@/components/_ui/hold-button";
import { SettingsCard } from "@/components/crm/settings-ui";
import WorkspaceTile from "@/components/workspaces/workspace-tile";
import type { BrowserRowView } from "@/lib/extension/settings";
import { cn } from "@/lib/utils";
import ExternalIcon from "@/public/assets/images/booking/external.svg";

type Workspace = { id: string; name: string };

function WorkspaceChip({ workspace }: { workspace: Workspace }) {
  return (
    <span className="caption-style text-soft flex items-center gap-1.5 rounded-md bg-white/[0.04] py-0.5 pr-2 pl-0.5">
      <WorkspaceTile id={workspace.id} name={workspace.name} className="size-4 rounded-[4px] text-[9px]" />
      {workspace.name}
    </span>
  );
}

function WorkspacePicker({ browser, workspaces, onDone }: { browser: BrowserRowView; workspaces: Workspace[]; onDone: () => void }) {
  const baseId = useId();
  const [chosen, setChosen] = useState(browser.workspaces.map((workspace) => workspace.id));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex w-full flex-col gap-2 pt-1"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        start(async () => {
          const result = await setBrowserWorkspacesAction(browser.id, chosen);
          if (result.error) setError(result.error);
          else onDone();
        });
      }}
    >
      <fieldset className="flex flex-col gap-1.5">
        <legend className="caption-style text-soft mb-1.5">Workspaces {browser.name} can reach</legend>
        {workspaces.map((workspace) => {
          const id = `${baseId}-${workspace.id}`;
          return (
            <label key={workspace.id} htmlFor={id} className="border-border flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2">
              <Checkbox
                id={id}
                checked={chosen.includes(workspace.id)}
                onCheckedChange={(value) =>
                  setChosen((current) => (value === true ? [...current, workspace.id] : current.filter((item) => item !== workspace.id)))
                }
              />
              <WorkspaceTile id={workspace.id} name={workspace.name} />
              <span className="ui-style">{workspace.name}</span>
            </label>
          );
        })}
      </fieldset>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={pending || chosen.length === 0}>
          Save
        </Button>
      </div>
    </form>
  );
}

function BrowserRow({ browser, workspaces }: { browser: BrowserRowView; workspaces: Workspace[] }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const showWorkspaces = workspaces.length > 1 || browser.workspaces.length === 0;
  return (
    <li className="border-border flex flex-wrap items-center justify-between gap-3 border-t py-3 first:border-t-0 first:pt-0 last:pb-0">
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-[14px] leading-5">{browser.name}</span>
        <span className="caption-style text-subtle flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className={cn("size-1.5 rounded-full", browser.active ? "bg-success" : "bg-faint")} />
            {browser.usedLabel}
          </span>
          <span>· Connected {browser.connectedLabel}</span>
        </span>
        {showWorkspaces && (
          <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {browser.workspaces.length > 0 ? (
              browser.workspaces.map((workspace) => <WorkspaceChip key={workspace.id} workspace={workspace} />)
            ) : (
              <span className="caption-style text-warning">No workspaces. Choose at least one.</span>
            )}
          </span>
        )}
      </span>
      <span className="flex items-center gap-1">
        {showWorkspaces && (
          <Button variant="ghost" size="sm" aria-expanded={editing} disabled={pending} onClick={() => setEditing((value) => !value)}>
            Workspaces<span className="sr-only"> for {browser.name}</span>
          </Button>
        )}
        <HoldButton
          disabled={pending}
          onConfirm={() =>
            start(async () => {
              setError(null);
              const result = await revokeBrowserAction(browser.id);
              if (result.error) setError(result.error);
            })
          }
        >
          Hold to revoke<span className="sr-only"> {browser.name}</span>
        </HoldButton>
      </span>
      {editing && <WorkspacePicker browser={browser} workspaces={workspaces} onDone={() => setEditing(false)} />}
      {error && (
        <p role="alert" className="caption-style text-danger w-full">
          {error}
        </p>
      )}
    </li>
  );
}

export default function LinkedinCaptureSettings({
  browsers,
  workspaces,
  extensionUrl,
}: {
  browsers: BrowserRowView[];
  workspaces: Workspace[];
  extensionUrl: string;
}) {
  return (
    <SettingsCard
      id="linkedin-capture"
      title="LinkedIn capture"
      description="A Chrome extension that saves people and companies from LinkedIn and Sales Navigator, and logs conversations when you press Log. Each browser is connected as you."
      action={
        <a href={extensionUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary", size: "sm" })}>
          Get the extension
          <ExternalIcon aria-hidden className="size-3" />
        </a>
      }
    >
      {browsers.length > 0 && (
        <ul aria-label="Connected browsers" className="flex flex-col">
          {browsers.map((browser) => (
            <BrowserRow key={browser.id} browser={browser} workspaces={workspaces} />
          ))}
        </ul>
      )}
      <p className="caption-style text-subtle leading-[1.4]">
        {browsers.length > 0
          ? "To connect another browser, install the extension and press Connect. Revoking signs that browser out straight away."
          : "No browsers connected yet. Install the extension, open it on LinkedIn and press Connect."}
      </p>
    </SettingsCard>
  );
}
