"use client";

import { Checkbox } from "@/components/_ui/checkbox";
import { Input } from "@/components/_ui/input";
import { recordSelectClass } from "@/components/crm/record-form";
import { matchLifecycleOption, type BuilderOptions } from "@/components/workflows/step-config";
import { EMAIL_KIND_LABELS, EMAIL_KINDS, FIELD_OPTIONS, PROPOSAL_EVENT_LABELS, PROPOSAL_EVENTS, TRIGGER_LABELS, TRIGGER_TYPES, type EmailKind, type ProposalEvent, type Trigger, type TriggerType } from "@/lib/workflows/definition";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function blank(type: TriggerType, options: BuilderOptions): Trigger {
  switch (type) {
    case "record_created":
    case "manual":
      return { type, object: "company" };
    case "field_changed":
      return { type, object: "company", field: "lifecycle", to: null };
    case "stage_changed":
      return { type, pipelineId: null, stageId: null };
    case "added_to_board":
      return { type, boardId: options.boards[0]?.id ?? "00000000-0000-4000-8000-000000000000" };
    case "activity_logged":
      return { type, activityType: null };
    case "schedule":
      return { type, frequency: "weekly", weekday: 1, time: "08:00" };
    case "email_received":
      return { type, kind: "any", fromContactsOnly: true };
    case "proposal_event":
      return { type, event: "signed", kind: null };
    default:
      return { type } as Trigger;
  }
}

function Labelled({ id, label, children, className }: { id: string; label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="caption-style text-subtle">
        {label}
      </label>
      {children}
    </div>
  );
}

export default function TriggerEditor({
  trigger,
  onChange,
  options,
}: {
  trigger: Trigger;
  onChange: (trigger: Trigger) => void;
  options: BuilderOptions;
}) {
  const stagesFor = (pipelineId: string | null | undefined) =>
    pipelineId ? (options.boards.find((board) => board.id === pipelineId)?.stages ?? []) : options.salesStages;

  return (
    <div className="flex flex-col gap-3">
      <Labelled id="trigger-type" label="When">
        <select
          id="trigger-type"
          value={trigger.type}
          onChange={(event) => onChange(blank(event.target.value as TriggerType, options))}
          className={recordSelectClass}
        >
          {TRIGGER_TYPES.map((type) => (
            <option key={type} value={type}>
              {TRIGGER_LABELS[type]}
            </option>
          ))}
        </select>
      </Labelled>

      {(trigger.type === "record_created" || trigger.type === "manual" || trigger.type === "field_changed") && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Labelled id="trigger-object" label="Record">
            <select
              id="trigger-object"
              value={trigger.object}
              onChange={(event) => {
                const object = event.target.value as "company" | "contact";
                onChange(trigger.type === "field_changed" ? { ...trigger, object, field: FIELD_OPTIONS[object][0].key } : { ...trigger, object });
              }}
              className={recordSelectClass}
            >
              <option value="company">Company</option>
              <option value="contact">Contact</option>
            </select>
          </Labelled>
          {trigger.type === "field_changed" && (
            <>
              <Labelled id="trigger-field" label="Field">
                <select id="trigger-field" value={trigger.field} onChange={(event) => onChange({ ...trigger, field: event.target.value })} className={recordSelectClass}>
                  {FIELD_OPTIONS[trigger.object].map((field) => (
                    <option key={field.key} value={field.key}>
                      {field.label}
                    </option>
                  ))}
                </select>
              </Labelled>
              <Labelled id="trigger-to" label="Changes to (optional)">
                {trigger.field === "lifecycle" ? (
                  <select
                    id="trigger-to"
                    value={trigger.to ? matchLifecycleOption(options.lifecycles, trigger.to) : ""}
                    onChange={(event) => onChange({ ...trigger, to: event.target.value || null })}
                    className={recordSelectClass}
                  >
                    <option value="">Anything</option>
                    {options.lifecycles.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : trigger.field === "health" ? (
                  <select id="trigger-to" value={trigger.to ?? ""} onChange={(event) => onChange({ ...trigger, to: event.target.value || null })} className={recordSelectClass}>
                    <option value="">Anything</option>
                    <option value="healthy">Healthy</option>
                    <option value="watch">Watch</option>
                    <option value="at_risk">At risk</option>
                  </select>
                ) : (
                  <Input id="trigger-to" value={trigger.to ?? ""} placeholder="Anything" onChange={(event) => onChange({ ...trigger, to: event.target.value || null })} />
                )}
              </Labelled>
            </>
          )}
        </div>
      )}

      {trigger.type === "stage_changed" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Labelled id="trigger-pipeline" label="Where">
            <select
              id="trigger-pipeline"
              value={trigger.pipelineId ?? ""}
              onChange={(event) => onChange({ ...trigger, pipelineId: event.target.value || null, stageId: null })}
              className={recordSelectClass}
            >
              <option value="">Opportunities</option>
              {options.boards.map((board) => (
                <option key={board.id} value={board.id}>
                  {board.name}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled id="trigger-stage" label="Moves to">
            <select id="trigger-stage" value={trigger.stageId ?? ""} onChange={(event) => onChange({ ...trigger, stageId: event.target.value || null })} className={recordSelectClass}>
              <option value="">Any stage</option>
              {stagesFor(trigger.pipelineId).map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </select>
          </Labelled>
        </div>
      )}

      {trigger.type === "added_to_board" && (
        <Labelled id="trigger-board" label="Board">
          {options.boards.length === 0 ? (
            <p className="caption-style text-subtle">Create a board under Opportunities first.</p>
          ) : (
            <select id="trigger-board" value={trigger.boardId} onChange={(event) => onChange({ ...trigger, boardId: event.target.value })} className={recordSelectClass}>
              {options.boards.map((board) => (
                <option key={board.id} value={board.id}>
                  {board.name}
                </option>
              ))}
            </select>
          )}
        </Labelled>
      )}

      {trigger.type === "activity_logged" && (
        <Labelled id="trigger-activity" label="Type" className="sm:w-56">
          <select
            id="trigger-activity"
            value={trigger.activityType ?? ""}
            onChange={(event) => onChange({ ...trigger, activityType: (event.target.value || null) as typeof trigger.activityType })}
            className={recordSelectClass}
          >
            <option value="">Any activity</option>
            <option value="call">Call</option>
            <option value="email">Email</option>
            <option value="meeting">Meeting</option>
            <option value="note">Note</option>
          </select>
        </Labelled>
      )}

      {trigger.type === "schedule" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Labelled id="trigger-frequency" label="Every">
            <select
              id="trigger-frequency"
              value={trigger.frequency}
              onChange={(event) => onChange({ ...trigger, frequency: event.target.value as "daily" | "weekly" | "monthly" })}
              className={recordSelectClass}
            >
              <option value="daily">Day</option>
              <option value="weekly">Week</option>
              <option value="monthly">Month</option>
            </select>
          </Labelled>
          {trigger.frequency === "monthly" && (
            <Labelled id="trigger-day" label="On day">
              <select
                id="trigger-day"
                value={String(trigger.dayOfMonth ?? 1)}
                onChange={(event) => onChange({ ...trigger, dayOfMonth: Number(event.target.value) })}
                className={recordSelectClass}
              >
                {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                  <option key={day} value={day}>
                    {day}
                  </option>
                ))}
              </select>
            </Labelled>
          )}
          {trigger.frequency === "weekly" && (
            <Labelled id="trigger-weekday" label="On">
              <select
                id="trigger-weekday"
                value={String(trigger.weekday ?? 1)}
                onChange={(event) => onChange({ ...trigger, weekday: Number(event.target.value) })}
                className={recordSelectClass}
              >
                {WEEKDAYS.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            </Labelled>
          )}
          <Labelled id="trigger-time" label="At (UK time)">
            <Input id="trigger-time" type="time" value={trigger.time} onChange={(event) => onChange({ ...trigger, time: event.target.value || "08:00" })} />
          </Labelled>
        </div>
      )}

      {trigger.type === "email_received" && (
        <div className="flex flex-col gap-3">
          <Labelled id="trigger-email-kind" label="Which emails">
            <select
              id="trigger-email-kind"
              value={trigger.kind}
              onChange={(event) => onChange({ ...trigger, kind: event.target.value as EmailKind })}
              className={recordSelectClass}
            >
              {EMAIL_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {EMAIL_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </Labelled>
          {(trigger.kind === "any" || trigger.kind === "reply" || trigger.kind === "auto_reply") && (
            <label className="caption-style text-subtle flex items-center gap-2">
              <Checkbox
                checked={trigger.fromContactsOnly !== false}
                onCheckedChange={(value) => onChange({ ...trigger, fromContactsOnly: value === true })}
              />
              Only from people who are contacts in Orbit
            </label>
          )}
          <p className="caption-style text-subtle">
            Runs on new email in your inbox, privately for you. {trigger.kind === "bounce" ? "The contact is the person whose address bounced." : "The contact is the sender."}
          </p>
        </div>
      )}

      {trigger.type === "proposal_event" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Labelled id="trigger-document-kind" label="Which">
            <select
              id="trigger-document-kind"
              value={trigger.kind ?? ""}
              onChange={(event) => onChange({ ...trigger, kind: (event.target.value || null) as "proposal" | "nda" | null })}
              className={recordSelectClass}
            >
              <option value="">Proposals and NDAs</option>
              <option value="proposal">Proposals</option>
              <option value="nda">NDAs</option>
            </select>
          </Labelled>
          <Labelled id="trigger-document-event" label="When it">
            <select
              id="trigger-document-event"
              value={trigger.event}
              onChange={(event) => onChange({ ...trigger, event: event.target.value as ProposalEvent })}
              className={recordSelectClass}
            >
              {PROPOSAL_EVENTS.map((item) => (
                <option key={item} value={item}>
                  {PROPOSAL_EVENT_LABELS[item]}
                </option>
              ))}
            </select>
          </Labelled>
        </div>
      )}

      {trigger.type === "manual" && (
        <p className="caption-style text-subtle">Adds a Run workflow button to {trigger.object === "company" ? "company" : "contact"} pages once it&apos;s on.</p>
      )}

      {trigger.type !== "manual" && trigger.type !== "schedule" && trigger.type !== "email_received" && trigger.type !== "proposal_event" && (
        <label className="caption-style text-subtle flex items-center gap-2">
          <Checkbox checked={Boolean(trigger.mine)} onCheckedChange={(value) => onChange({ ...trigger, mine: value === true })} />
          Only when it&apos;s mine (my call, my change or my task)
        </label>
      )}
    </div>
  );
}
