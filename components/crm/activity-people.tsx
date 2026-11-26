"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import RecordCombobox from "@/components/crm/record-combobox";
import { addActivityPersonAction, removeActivityPersonAction } from "@/app/(crm)/records";
import { contactHref } from "@/lib/crm/hrefs";
import type { ActivityPerson } from "@/lib/crm/types";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

export default function ActivityPeople({
  activityId,
  people,
  mainId,
}: {
  activityId: string;
  people: ActivityPerson[];
  mainId: string | null;
}) {
  const router = useRouter();
  const fieldId = useId();
  const [added, setAdded] = useState<ActivityPerson[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = [
    ...people.filter((person) => !removed.includes(person.id)),
    ...added.filter((person) => !people.some((item) => item.id === person.id) && !removed.includes(person.id)),
  ];

  async function add(person: { id: string; name: string }) {
    setPending(true);
    setError(null);
    const result = await addActivityPersonAction(activityId, person.id);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setRemoved((current) => current.filter((id) => id !== person.id));
    setAdded((current) => [...current, { id: person.id, name: person.name }]);
    setAdding(false);
    router.refresh();
  }

  async function remove(person: ActivityPerson) {
    setPending(true);
    setError(null);
    const result = await removeActivityPersonAction(activityId, person.id);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setAdded((current) => current.filter((item) => item.id !== person.id));
    setRemoved((current) => [...current, person.id]);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="caption-style text-subtle">People</span>
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pointer-coarse:gap-x-5 pointer-coarse:gap-y-4">
        {shown.map((person) => (
          <li key={person.id} className="flex min-w-0 items-center gap-1 pointer-coarse:gap-3">
            <Link href={contactHref(person.id)} className="text-[14px] leading-5 underline decoration-from-font underline-offset-2 hover:text-soft">
              {person.name}
            </Link>
            {person.id !== mainId && (
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label={`Remove ${person.name}`}
                disabled={pending}
                className="hit"
                onClick={() => void remove(person)}
              >
                <XIcon aria-hidden className="size-3" />
              </Button>
            )}
          </li>
        ))}
        <li>
          {adding ? (
            <div className="flex min-w-[14em] items-center gap-1.5 pointer-coarse:gap-4">
              <RecordCombobox
                id={fieldId}
                kind="contact"
                label="Add person"
                placeholder="Find a person"
                value={null}
                onChange={(picked) => {
                  if (picked) void add(picked);
                }}
                autoFocus
                onCancel={() => setAdding(false)}
                className="flex-1"
              />
              <Button variant="ghost" size="sm" type="button" className="hit" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="ghost" size="sm" type="button" className="hit" disabled={pending} onClick={() => setAdding(true)}>
              Add person
            </Button>
          )}
        </li>
      </ul>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
