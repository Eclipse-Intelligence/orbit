"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import {
  archiveWebhookAction,
  createWebhookAction,
  saveStagesAction,
} from "@/app/(crm)/settings/actions";
import type { PipelineStage } from "@/lib/crm/types";
import type { WebhookDelivery, WebhookEndpoint } from "@/lib/crm/webhooks";

const EVENT_CHOICES = [
  "company.created",
  "company.updated",
  "contact.created",
  "lead.created",
  "opportunity.created",
  "opportunity.stage_changed",
  "activity.created",
  "task.created",
  "task.completed",
];

export default function SettingsScreen({
  viewer,
  canAdmin,
  stages,
  endpoints,
  deliveries,
}: {
  viewer: Viewer;
  canAdmin: boolean;
  stages: PipelineStage[];
  endpoints: WebhookEndpoint[];
  deliveries: WebhookDelivery[];
}) {
  const router = useRouter();
  const [drafts, setDrafts] = useState(stages);
  const [stageSource, setStageSource] = useState(stages);
  if (stageSource !== stages) {
    setStageSource(stages);
    setDrafts(stages);
  }
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["lead.created", "task.completed"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function saveStages() {
    setPending(true);
    setError(null);
    const result = await saveStagesAction(
      drafts.map((stage) => ({
        id: stage.id.startsWith("new-") ? undefined : stage.id,
        name: stage.name,
        probability: stage.probability,
        isWon: stage.isWon,
        isLost: stage.isLost,
      })),
    );
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  async function saveWebhook() {
    setPending(true);
    setError(null);
    setSecret(null);
    const result = await createWebhookAction(url, events, "");
    setPending(false);
    if ("error" in result && result.error) {
      setError(result.error);
      return;
    }
    if ("secret" in result && result.secret) setSecret(result.secret);
    setUrl("");
    router.refresh();
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader title="Settings" viewer={viewer} />
      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-auto px-4 py-5">
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
        <div className="flex max-w-[640px] flex-col gap-3">
          <h2>Pipeline</h2>
          <p className="caption-style text-subtle">
            Keep one won stage and one lost stage. A stage with opportunities stays until those records move.
          </p>
          {drafts.map((stage, index) => (
            <div key={stage.id} className="grid gap-2 sm:grid-cols-[1fr_90px_auto_auto_auto]">
              <Input
                aria-label={`Stage ${index + 1} name`}
                value={stage.name}
                onChange={(event) =>
                  setDrafts((current) =>
                    current.map((item) => (item.id === stage.id ? { ...item, name: event.target.value } : item)),
                  )
                }
              />
              <Input
                aria-label={`${stage.name} probability`}
                inputMode="numeric"
                value={String(stage.probability)}
                onChange={(event) =>
                  setDrafts((current) =>
                    current.map((item) =>
                      item.id === stage.id
                        ? { ...item, probability: Number(event.target.value) || 0 }
                        : item,
                    ),
                  )
                }
              />
              <label className="caption-style flex items-center gap-2">
                <input
                  type="radio"
                  name="won-stage"
                  checked={stage.isWon}
                  onChange={() =>
                    setDrafts((current) =>
                      current.map((item) => ({
                        ...item,
                        isWon: item.id === stage.id,
                        isLost: item.id === stage.id ? false : item.isLost,
                        probability: item.id === stage.id ? 100 : item.probability,
                      })),
                    )
                  }
                />
                Won
              </label>
              <label className="caption-style flex items-center gap-2">
                <input
                  type="radio"
                  name="lost-stage"
                  checked={stage.isLost}
                  onChange={() =>
                    setDrafts((current) =>
                      current.map((item) => ({
                        ...item,
                        isLost: item.id === stage.id,
                        isWon: item.id === stage.id ? false : item.isWon,
                        probability: item.id === stage.id ? 0 : item.probability,
                      })),
                    )
                  }
                />
                Lost
              </label>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={pending || drafts.length <= 2 || stage.isWon || stage.isLost}
                onClick={() => setDrafts((current) => current.filter((item) => item.id !== stage.id))}
              >
                Remove
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() =>
                setDrafts((current) => {
                  const next = {
                    id: `new-${crypto.randomUUID()}`,
                    pipelineId: current[0]?.pipelineId ?? "",
                    name: "New stage",
                    position: current.length,
                    probability: 20,
                    isWon: false,
                    isLost: false,
                  };
                  const lostAt = current.findIndex((stage) => stage.isLost);
                  if (lostAt < 0) return [...current, next];
                  return [...current.slice(0, lostAt), next, ...current.slice(lostAt)];
                })
              }
            >
              Add stage
            </Button>
            <Button variant="secondary" size="sm" type="button" onClick={saveStages} disabled={pending}>
              Save pipeline
            </Button>
          </div>
        </div>

        <div className="flex max-w-[640px] flex-col gap-3">
          <h2>Webhooks</h2>
          <p className="caption-style text-subtle">
            Events are signed with HMAC SHA-256 in the X-CRM-Signature header. Deliveries retry for about three hours.
          </p>
          {canAdmin ? (
            <>
              <label className="flex flex-col gap-2" htmlFor="webhook-url">
                <span className="caption-style text-subtle">Endpoint URL</span>
                <Input
                  id="webhook-url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com/crm"
                />
              </label>
              <div className="flex flex-wrap gap-3">
                {EVENT_CHOICES.map((event) => (
                  <label key={event} className="caption-style flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={events.includes(event)}
                      onChange={(change) =>
                        setEvents((current) =>
                          change.target.checked ? [...current, event] : current.filter((item) => item !== event),
                        )
                      }
                    />
                    {event}
                  </label>
                ))}
              </div>
              <Button variant="primary" size="sm" className="self-start" type="button" onClick={saveWebhook} disabled={pending || !url.trim()}>
                Add webhook
              </Button>
              {secret && (
                <p className="caption-style text-soft">
                  Signing secret, shown once: <span className="text-foreground">{secret}</span>
                </p>
              )}
            </>
          ) : (
            <p className="caption-style text-subtle">Only an owner or admin can add webhooks.</p>
          )}
          <ul className="flex flex-col gap-2">
            {endpoints.map((endpoint) => (
              <li key={endpoint.id} className="border-border flex items-center justify-between gap-3 border-b py-2">
                <span className="min-w-0">
                  <span className="block truncate text-[14px] leading-5">{endpoint.url}</span>
                  <span className="caption-style text-subtle block truncate">{endpoint.events.join(", ")}</span>
                </span>
                {canAdmin && (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={async () => {
                      await archiveWebhookAction(endpoint.id);
                      router.refresh();
                    }}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {deliveries.length > 0 && (
            <ul className="flex flex-col gap-2">
              {deliveries.map((delivery) => (
                <li key={delivery.id} className="caption-style text-subtle">
                  {delivery.eventType} · {delivery.status}
                  {delivery.lastError ? ` · ${delivery.lastError}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex max-w-[640px] flex-col gap-2">
          <h2>Email and calendar</h2>
          <p className="caption-style text-subtle">
            Agents file emails and meetings with record_email and record_meeting. The CRM matches the person by email and the company by domain, then suggests a follow-up when none is open. Connecting Gmail, Outlook, or calendars directly still needs your own OAuth app, which is separate from Supabase.
          </p>
        </div>
      </div>
    </section>
  );
}
