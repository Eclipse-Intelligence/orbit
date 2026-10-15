"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { ClickUpListOptions, listGroups } from "@/components/crm/clickup";
import { recordSelectClass } from "@/components/crm/record-form";
import { SettingsCard, SettingsDisclosure } from "@/components/crm/settings-ui";
import {
  disableClickUpWebhookAction,
  enableClickUpWebhookAction,
  saveClickUpSettingsAction,
  syncClickUpAction,
  type ClickUpActionState,
} from "@/app/(crm)/settings/actions";
import { formatWhen } from "@/lib/companies";
import type { ClickUpSettingsView } from "@/lib/crm/clickup";

export default function ClickUpSettings({
  view,
  canAdmin,
}: {
  view: ClickUpSettingsView;
  canAdmin: boolean;
}) {
  const router = useRouter();
  const [teamId, setTeamId] = useState(view.teamId ?? view.teams[0]?.id ?? "");
  const [defaultListId, setDefaultListId] = useState(view.defaultListId ?? "");
  const [watched, setWatched] = useState<string[]>(view.watchedListIds);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<ClickUpActionState>({});
  const sameTeam = teamId === view.teamId;
  const lists = sameTeam ? view.lists : [];

  async function run(action: () => Promise<ClickUpActionState>) {
    setPending(true);
    setOutcome({});
    const result = await action();
    setPending(false);
    setOutcome(result);
    router.refresh();
  }

  if (!view.configured) {
    return (
      <SettingsCard
        id="clickup"
        title="ClickUp"
        description="To sync tasks with ClickUp, create a personal token in ClickUp under Settings › Apps › API Token, add it as CLICKUP_API_TOKEN in the server environment (in Vercel, Settings › Environment Variables), then redeploy."
      />
    );
  }

  return (
    <SettingsCard
      id="clickup"
      title="ClickUp"
      description={
        <span className="flex flex-col gap-1.5">
          <span>
            {view.user
              ? `Connected as ${view.user.username ?? view.user.email ?? "ClickUp user"}`
              : "ClickUp token set"}
            {" · "}
            {view.lastSyncedAt
              ? `Last synced ${formatWhen(view.lastSyncedAt)}`
              : "Not synced yet"}
            {view.webhookEnabled
              ? " · Instant sync on"
              : " · Checked every 10 minutes"}
          </span>
          {(view.error || view.lastError) && (
            <span className="text-danger" role="alert">
              {view.error ?? view.lastError}
            </span>
          )}
        </span>
      }
      action={
        view.teamId && (
          <>
            {canAdmin &&
              (view.webhookEnabled ? (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={pending}
                  onClick={() => run(disableClickUpWebhookAction)}
                >
                  Turn off instant sync
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={pending || !view.siteUrl?.startsWith("https://")}
                  title={
                    view.siteUrl?.startsWith("https://")
                      ? undefined
                      : "Set SITE_URL to Orbit's https address first."
                  }
                  onClick={() => run(enableClickUpWebhookAction)}
                >
                  Enable instant ClickUp sync
                </Button>
              ))}
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={pending}
              onClick={() => run(syncClickUpAction)}
            >
              {pending ? "Working…" : "Sync now"}
            </Button>
          </>
        )
      }
    >
      {outcome.error && (
        <p role="alert" className="caption-style text-danger">
          {outcome.error}
        </p>
      )}
      {outcome.message && (
        <p role="status" className="caption-style text-soft">
          {outcome.message}
        </p>
      )}
      {canAdmin ? (
        <>
          {view.teams.length > 1 && (
            <label className="flex flex-col gap-2" htmlFor="clickup-team">
              <span className="caption-style text-subtle">Workspace</span>
              <select
                id="clickup-team"
                value={teamId}
                onChange={(event) => setTeamId(event.target.value)}
                className={recordSelectClass}
              >
                {view.teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {sameTeam && lists.length > 0 && (
            <>
              <label
                className="flex flex-col gap-2"
                htmlFor="clickup-default-list"
              >
                <span className="caption-style text-subtle">
                  Default list for new tasks
                </span>
                <select
                  id="clickup-default-list"
                  value={defaultListId}
                  onChange={(event) => setDefaultListId(event.target.value)}
                  className={recordSelectClass}
                >
                  <option value="">No default</option>
                  <ClickUpListOptions lists={lists} />
                </select>
              </label>
              <SettingsDisclosure
                title="Watched lists"
                summary={`${watched.length} ${watched.length === 1 ? "list" : "lists"} watched. Their tasks become Orbit tasks when Orbit can tell which contact or company they are for.`}
              >
                <fieldset className="flex flex-col gap-2">
                  <legend className="sr-only">Watched lists</legend>
                  <div className="flex max-h-[18em] flex-col gap-3 overflow-auto">
                    {listGroups(lists).map((group) => (
                      <div key={group.label} className="flex flex-col gap-1.5">
                        <span className="caption-style text-subtle">
                          {group.label}
                        </span>
                        {group.lists.map((list) => (
                          <label
                            key={list.id}
                            className="flex items-center gap-2 text-[14px] leading-5"
                          >
                            <input
                              type="checkbox"
                              checked={watched.includes(list.id)}
                              onChange={(event) =>
                                setWatched((current) =>
                                  event.target.checked
                                    ? [...current, list.id]
                                    : current.filter((id) => id !== list.id),
                                )
                              }
                            />
                            {list.name}
                          </label>
                        ))}
                      </div>
                    ))}
                  </div>
                </fieldset>
              </SettingsDisclosure>
            </>
          )}
          {teamId && (
            <Button
              variant="primary"
              size="sm"
              className="self-start"
              type="button"
              disabled={pending}
              onClick={() =>
                run(() =>
                  saveClickUpSettingsAction({
                    teamId,
                    defaultListId: sameTeam ? defaultListId || null : null,
                    watchedListIds: sameTeam ? watched : [],
                  }),
                )
              }
            >
              {sameTeam ? "Save ClickUp settings" : "Use this workspace"}
            </Button>
          )}
        </>
      ) : (
        <p className="caption-style text-subtle">
          Only an owner or admin can change the ClickUp settings.
        </p>
      )}
      <SettingsDisclosure
        title="Linking tasks made in ClickUp"
        summary="How Orbit knows who a ClickUp task is for."
      >
        <p className="caption-style text-subtle leading-[1.4]">
          To link tasks you create in ClickUp, add a text custom field named
          Orbit to the list and put the contact&apos;s email, the company&apos;s
          domain, or the Orbit link in it. A contact&apos;s email or an Orbit
          link in the task description works too.
        </p>
      </SettingsDisclosure>
    </SettingsCard>
  );
}
