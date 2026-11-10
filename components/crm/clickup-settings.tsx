"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import Switch from "@/components/_ui/switch";
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
import { GENERIC_ERROR } from "@/lib/utils";

export default function ClickUpSettings({
  view,
  canAdmin,
  isOwner,
}: {
  view: ClickUpSettingsView;
  canAdmin: boolean;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [teamId, setTeamId] = useState(view.teamId ?? view.teams[0]?.id ?? "");
  const [defaultListId, setDefaultListId] = useState(view.defaultListId ?? "");
  const [watched, setWatched] = useState<string[]>(view.watchedListIds);
  const saved = [view.teamId, view.defaultListId, ...view.watchedListIds].join("\n");
  const [shownSaved, setShownSaved] = useState(saved);
  if (shownSaved !== saved) {
    setShownSaved(saved);
    setTeamId(view.teamId ?? view.teams[0]?.id ?? "");
    setDefaultListId(view.defaultListId ?? "");
    setWatched(view.watchedListIds);
  }
  const [pending, setPending] = useState<"sync" | "other" | null>(null);
  const [outcome, setOutcome] = useState<ClickUpActionState>({});
  const sameTeam = teamId === view.teamId;
  const lists = sameTeam ? view.lists : [];

  const httpsSite = view.siteUrl?.startsWith("https://") ?? false;

  async function run(action: () => Promise<ClickUpActionState>, kind: "sync" | "other" = "other") {
    setPending(kind);
    setOutcome({});
    const result = await action().catch((): ClickUpActionState => ({ error: GENERIC_ERROR }));
    setPending(null);
    setOutcome(result);
    router.refresh();
  }

  if (!view.configured) {
    return (
      <SettingsCard
        id="clickup"
        title="ClickUp"
        description={isOwner ? "Add CLICKUP_API_TOKEN in Vercel (ClickUp › Settings › Apps › API Token), then redeploy." : "ClickUp isn't set up."}
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
              : "Connected"}
            {" · "}
            {view.lastSyncedAt
              ? `Synced ${formatWhen(view.lastSyncedAt)}`
              : "Not synced"}
          </span>
          {view.shared.map((item) => (
            <span key={item.workspaceId} className="text-subtle">
              {`${item.workspaceName} also watches ${item.listNames.join(", ")}. Tasks in a list both workspaces watch sync into both.`}
            </span>
          ))}
          {view.teamId && !view.webhookEnabled && !httpsSite && (
            <span className="text-subtle">{isOwner ? "Instant sync needs SITE_URL set to Orbit's https address." : "Instant sync isn't set up."}</span>
          )}
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
            <label className="flex items-center gap-2">
              <span className="caption-style text-subtle">Instant sync</span>
              <Switch
                checked={view.webhookEnabled}
                label="Instant sync"
                disabled={!canAdmin || pending !== null || (!view.webhookEnabled && !httpsSite)}
                onChange={(on) => run(on ? enableClickUpWebhookAction : disableClickUpWebhookAction)}
              />
            </label>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={pending !== null}
              onClick={() => run(syncClickUpAction, "sync")}
            >
              {pending === "sync" ? "Syncing…" : "Sync"}
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
              <span className="caption-style text-subtle">ClickUp workspace</span>
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
              <SettingsDisclosure title={`Watched lists (${watched.length})`}>
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
              disabled={pending !== null}
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
              {sameTeam ? "Save" : "Use this workspace"}
            </Button>
          )}
        </>
      ) : (
        <p className="caption-style text-subtle">
          Only owners and admins can change ClickUp settings.
        </p>
      )}
      <p className="caption-style text-subtle leading-[1.4]">
        Linking ClickUp tasks: add a text custom field named Orbit to the list,
        holding the contact&apos;s email, company domain or Orbit link. An email
        or Orbit link in the description also works.
      </p>
    </SettingsCard>
  );
}
