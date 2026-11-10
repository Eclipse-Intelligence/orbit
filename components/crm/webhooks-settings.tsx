"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import { Input } from "@/components/_ui/input";
import { SettingsCard, SettingsDisclosure } from "@/components/crm/settings-ui";
import {
  archiveWebhookAction,
  createWebhookAction,
} from "@/app/(crm)/settings/actions";
import { formatWhen } from "@/lib/companies";
import type { WebhookDelivery, WebhookEndpoint } from "@/lib/crm/webhooks";
import { cn, GENERIC_ERROR } from "@/lib/utils";

const EVENT_CHOICES = [
  "company.created",
  "company.updated",
  "company.ai_field_changed",
  "contact.created",
  "lead.created",
  "opportunity.created",
  "opportunity.stage_changed",
  "activity.created",
  "task.created",
  "task.completed",
];

function deliveryTone(status: string) {
  if (status === "delivered") return "text-success";
  if (status === "failed") return "text-danger";
  return "text-subtle";
}

export default function WebhooksSettings({
  endpoints,
  deliveries,
  canAdmin,
}: {
  endpoints: WebhookEndpoint[];
  deliveries: WebhookDelivery[];
  canAdmin: boolean;
}) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([
    "lead.created",
    "task.completed",
  ]);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function saveWebhook() {
    setPending(true);
    setError(null);
    setSecret(null);
    const result = await createWebhookAction(url, events, "").catch(() => ({ error: GENERIC_ERROR }));
    setPending(false);
    if ("error" in result && result.error) {
      setError(result.error);
      return;
    }
    if ("secret" in result && result.secret) setSecret(result.secret);
    setUrl("");
    router.refresh();
  }

  async function remove(id: string) {
    setPending(true);
    setError(null);
    const result = await archiveWebhookAction(id).catch(() => ({ error: GENERIC_ERROR }));
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <SettingsCard id="webhooks" title="Webhooks" description="Retries for about three hours.">
      {endpoints.length === 0 ? (
        <p className="caption-style text-subtle">No webhooks</p>
      ) : (
        <ul className="flex flex-col">
          {endpoints.map((endpoint) => (
            <li
              key={endpoint.id}
              className="border-border flex items-center justify-between gap-3 border-b py-2 last:border-b-0"
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="block truncate text-[14px] leading-5">
                  {endpoint.url}
                </span>
                <span className="caption-style text-subtle block truncate">
                  {endpoint.events.join(", ")}
                </span>
              </span>
              {canAdmin && (
                <HoldButton
                  disabled={pending}
                  onConfirm={() => void remove(endpoint.id)}
                >
                  Hold to delete
                  <span className="sr-only">{` webhook ${endpoint.url}`}</span>
                </HoldButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      {secret && (
        <p role="status" className="caption-style text-soft leading-[1.4]">
          Signing secret (HMAC SHA-256, X-CRM-Signature header), shown once:{" "}
          <span className="text-foreground font-mono break-all">{secret}</span>
        </p>
      )}
      {canAdmin ? (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-2" htmlFor="webhook-url">
            <span className="caption-style text-subtle">Endpoint URL</span>
            <Input
              id="webhook-url"
              value={url}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/crm"
            />
          </label>
          <fieldset className="flex flex-col gap-2">
            <legend className="caption-style text-subtle pb-2">Events</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {EVENT_CHOICES.map((event) => (
                <label
                  key={event}
                  className="caption-style flex items-center gap-2"
                >
                  <input
                    type="checkbox"
                    checked={events.includes(event)}
                    onChange={(change) =>
                      setEvents((current) =>
                        change.target.checked
                          ? [...current, event]
                          : current.filter((item) => item !== event),
                      )
                    }
                  />
                  {event}
                </label>
              ))}
            </div>
          </fieldset>
          <Button
            variant="primary"
            size="sm"
            className="self-start"
            type="button"
            onClick={saveWebhook}
            disabled={pending || !url.trim() || events.length === 0}
          >
            {pending ? "Saving…" : "Add webhook"}
          </Button>
        </div>
      ) : (
        <p className="caption-style text-subtle">
          Only owners and admins can add webhooks.
        </p>
      )}
      {deliveries.length > 0 && (
        <SettingsDisclosure title={`Recent deliveries (${deliveries.length})`}>
          <ul className="flex flex-col">
            {deliveries.map((delivery) => (
              <li
                key={delivery.id}
                className="border-border flex flex-col gap-1 border-b py-2 first:pt-0 last:border-b-0 last:pb-0"
              >
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[12px] leading-5">
                    {delivery.eventType}
                  </span>
                  <span
                    className={cn(
                      "caption-style",
                      deliveryTone(delivery.status),
                    )}
                  >
                    {delivery.status}
                    {delivery.lastStatusCode
                      ? ` · ${delivery.lastStatusCode}`
                      : ""}
                  </span>
                </span>
                <span className="caption-style text-subtle">
                  {formatWhen(delivery.createdAt)} · {delivery.attempts}{" "}
                  {delivery.attempts === 1 ? "attempt" : "attempts"}
                </span>
                {delivery.lastError && (
                  <span className="caption-style text-danger break-words">
                    {delivery.lastError}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </SettingsDisclosure>
      )}
    </SettingsCard>
  );
}
