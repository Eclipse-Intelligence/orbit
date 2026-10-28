"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { DateTimePicker } from "@/components/_ui/date-picker";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import {
  Sheet,
  SheetCloseButton,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/_ui/sheet";
import { Textarea } from "@/components/_ui/textarea";
import RecordPicker, { type PickedRecord } from "@/components/crm/record-picker";
import { companyOpportunitiesAction, updateActivityAction } from "@/app/(crm)/records";
import {
  activityOrigin,
  editableFields,
  EDITABLE_TYPES,
  ORIGIN_LIMITS,
  type ActivityEdit,
  type ActivityEditField,
} from "@/lib/crm/activity-edit";
import type { Activity, ActivityType } from "@/lib/crm/types";
import { dateTimeInputValue } from "@/lib/time";

const TYPE_LABELS: Record<ActivityType, string> = {
  note: "Note",
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  research: "Research",
  linkedin: "LinkedIn",
  agent_update: "Agent update",
  other: "Other",
};

const NONE = "none";

type Option = { id: string; name: string };

function pickedCompany(activity: Activity): PickedRecord | null {
  return activity.companyId ? { id: activity.companyId, name: activity.companyName ?? "Current company" } : null;
}

function pickedContact(activity: Activity): PickedRecord | null {
  if (!activity.contactId) return null;
  return { id: activity.contactId, name: activity.contactName ?? "Current person", company: pickedCompany(activity) };
}

export function EditActivityButton({ activity, hasTranscript }: { activity: Activity; hasTranscript: boolean }) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        type="button"
        onClick={() => {
          setSession((current) => current + 1);
          setOpen(true);
        }}
      >
        Edit
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="sm:w-[480px] sm:max-w-[480px]">
          <SheetHeader>
            <SheetTitle>Edit activity</SheetTitle>
            <SheetDescription className="sr-only">Change what was logged and where it is filed</SheetDescription>
            <SheetCloseButton />
          </SheetHeader>
          {open && (
            <ActivityEditor
              key={session}
              activity={activity}
              hasTranscript={hasTranscript}
              onClose={() => setOpen(false)}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function ActivityEditor({
  activity,
  hasTranscript,
  onClose,
}: {
  activity: Activity;
  hasTranscript: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const id = useId();
  const origin = activityOrigin(activity, hasTranscript);
  const allowed = new Set<ActivityEditField>(editableFields(origin));
  const initialWhen = dateTimeInputValue(activity.occurredAt);
  const [type, setType] = useState<ActivityType>(activity.type);
  const [title, setTitle] = useState(activity.title ?? "");
  const [body, setBody] = useState(activity.body ?? "");
  const [when, setWhen] = useState(initialWhen);
  const [company, setCompany] = useState<PickedRecord | null>(pickedCompany(activity));
  const [contact, setContact] = useState<PickedRecord | null>(pickedContact(activity));
  const [opportunityId, setOpportunityId] = useState(activity.opportunityId ?? NONE);
  const [opportunities, setOpportunities] = useState<{ companyId: string; options: Option[] } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const companyId = company?.id ?? null;
  const typeOptions = (EDITABLE_TYPES as readonly ActivityType[]).includes(activity.type) ? EDITABLE_TYPES : [...EDITABLE_TYPES, activity.type];
  const current = activity.opportunityId && activity.companyId === companyId ? { id: activity.opportunityId, name: activity.opportunityName ?? "Current opportunity" } : null;
  const listed = opportunities?.companyId === companyId ? opportunities.options : [];
  const opportunityOptions = current && !listed.some((option) => option.id === current.id) ? [current, ...listed] : listed;

  const linksDeals = allowed.has("opportunityId");

  useEffect(() => {
    if (!companyId || !linksDeals) return;
    let live = true;
    void companyOpportunitiesAction(companyId).then((result) => {
      if (live) setOpportunities({ companyId, options: result.opportunities });
    });
    return () => {
      live = false;
    };
  }, [companyId, linksDeals]);

  function chooseCompany(next: PickedRecord | null) {
    setCompany(next);
    setOpportunityId(next && next.id === activity.companyId ? (activity.opportunityId ?? NONE) : NONE);
    if (allowed.has("contactId") && contact && next && contact.company?.id !== next.id) setContact(null);
  }

  function chooseContact(next: PickedRecord | null) {
    setContact(next);
    if (next?.company && next.company.id !== company?.id && allowed.has("companyId")) chooseCompany(next.company);
  }

  function changes(): ActivityEdit {
    const edit: ActivityEdit = {};
    if (allowed.has("type") && type !== activity.type) edit.type = type;
    if (allowed.has("title") && title.trim() !== (activity.title ?? "")) edit.title = title.trim() || null;
    if (allowed.has("body") && body.trim() !== (activity.body ?? "")) edit.body = body.trim() || null;
    if (allowed.has("occurredAt") && when !== initialWhen) edit.occurredAt = when;
    if (allowed.has("companyId") && companyId !== activity.companyId) edit.companyId = companyId;
    if (allowed.has("contactId") && (contact?.id ?? null) !== activity.contactId) edit.contactId = contact?.id ?? null;
    const opportunity = opportunityId === NONE ? null : opportunityId;
    if (allowed.has("opportunityId") && opportunity !== activity.opportunityId) edit.opportunityId = opportunity;
    return edit;
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const edit = changes();
    if (Object.keys(edit).length === 0) {
      onClose();
      return;
    }
    if (allowed.has("occurredAt") && !when) {
      setError("Pick when it happened.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await updateActivityAction(activity.id, edit).catch(() => ({ error: "That didn't save. Try again." }));
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onClose();
    router.refresh();
  }

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-4 overflow-auto p-5">
        {origin !== "logged" && <p className="caption-style text-subtle">{ORIGIN_LIMITS[origin]}</p>}
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
        {allowed.has("type") && (
          <label className="flex flex-col gap-2" htmlFor={`${id}-type`}>
            <span className="caption-style text-subtle">Type</span>
            <NativeSelect id={`${id}-type`} value={type} onChange={(event) => setType(event.target.value as ActivityType)}>
              {typeOptions.map((option) => (
                <option key={option} value={option}>
                  {TYPE_LABELS[option]}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
        {allowed.has("title") && (
          <label className="flex flex-col gap-2" htmlFor={`${id}-title`}>
            <span className="caption-style text-subtle">Title</span>
            <Input id={`${id}-title`} value={title} maxLength={200} autoComplete="off" onChange={(event) => setTitle(event.target.value)} />
          </label>
        )}
        {allowed.has("body") && (
          <label className="flex flex-col gap-2" htmlFor={`${id}-body`}>
            <span className="caption-style text-subtle">Text</span>
            <Textarea id={`${id}-body`} value={body} maxLength={10000} className="min-h-32" onChange={(event) => setBody(event.target.value)} />
          </label>
        )}
        {allowed.has("occurredAt") && (
          <div className="flex min-w-0 flex-col gap-2">
            <label className="caption-style text-subtle" htmlFor={`${id}-when`}>
              When
            </label>
            <DateTimePicker id={`${id}-when`} value={when} onChange={setWhen} placeholder="Pick when it happened" />
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-2">
          <label className="caption-style text-subtle" htmlFor={`${id}-company`}>
            Company
          </label>
          <RecordPicker id={`${id}-company`} kind="company" value={company} onChange={chooseCompany} placeholder="Choose a company" />
        </div>
        {allowed.has("contactId") ? (
          <div className="flex min-w-0 flex-col gap-2">
            <label className="caption-style text-subtle" htmlFor={`${id}-contact`}>
              Person
            </label>
            <RecordPicker
              id={`${id}-contact`}
              kind="contact"
              value={contact}
              onChange={chooseContact}
              placeholder={company ? `Choose someone at ${company.name}` : "Choose a person"}
              companyId={companyId}
            />
          </div>
        ) : (
          activity.contactName && (
            <div className="flex min-w-0 flex-col gap-1">
              <span className="caption-style text-subtle">Person</span>
              <p className="text-[14px] leading-5">{activity.contactName}</p>
            </div>
          )
        )}
        <label className="flex flex-col gap-2" htmlFor={`${id}-opportunity`}>
          <span className="caption-style text-subtle">Opportunity</span>
          <NativeSelect
            id={`${id}-opportunity`}
            value={opportunityId}
            disabled={!companyId}
            onChange={(event) => setOpportunityId(event.target.value)}
          >
            <option value={NONE}>{companyId ? "None" : "Choose a company first"}</option>
            {opportunityOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
      <SheetFooter>
        <Button variant="subtle" size="sm" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" type="submit" disabled={pending} data-shortcut="save" title="Save (⌘S)">
          {pending ? "Saving…" : "Save"}
        </Button>
      </SheetFooter>
    </form>
  );
}
