"use client";

import { Checkbox } from "@/components/_ui/checkbox";
import { Input } from "@/components/_ui/input";
import { recordSelectClass } from "@/components/crm/record-form";
import type { BuilderOptions } from "@/components/workflows/step-config";
import { FIELD_OPTIONS, TRIGGER_LABELS, TRIGGER_TYPES, type Trigger, type TriggerType } from "@/lib/workflows/definition";
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
                  <select id="trigger-to" value={trigger.to ?? ""} onChange={(event) => onChange({ ...trigger, to: event.target.value || null })} className={recordSelectClass}>
                    <option value="">Anything</option>
                    <option value="lead">Lead</option>
                    <option value="prospect">Prospect</option>
                    <option value="customer">Customer</option>
                    <option value="churned">Churned</option>
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
              onChange={(event) => onChange({ ...trigger, frequency: event.target.value as "daily" | "weekly" })}
              className={recordSelectClass}
            >
              <option value="daily">Day</option>
              <option value="weekly">Week</option>
            </select>
          </Labelled>
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

      {trigger.type === "manual" && (
        <p className="caption-style text-subtle">Adds a Run workflow button to {trigger.object === "company" ? "company" : "contact"} pages once it&apos;s on.</p>
      )}

      {trigger.type !== "manual" && trigger.type !== "schedule" && (
        <label className="caption-style text-subtle flex items-center gap-2">
          <Checkbox checked={Boolean(trigger.mine)} onCheckedChange={(value) => onChange({ ...trigger, mine: value === true })} />
          Only when it&apos;s mine (my call, my change or my task)
        </label>
      )}
    </div>
  );
}
