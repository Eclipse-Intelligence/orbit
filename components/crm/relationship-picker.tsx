"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { NativeSelect } from "@/components/_ui/native-select";
import { setRelationshipAction } from "@/app/(crm)/actions";
import { formatDate } from "@/lib/companies";
import { isRelationshipLabel, RELATIONSHIP_LABELS, RELATIONSHIP_META, type Relationship } from "@/lib/crm/relationship-score";
import { cn } from "@/lib/utils";

export function useRelationshipPicker(target: "company" | "contact", id: string) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function change(value: string) {
    setError(null);
    startTransition(async () => {
      const result = await setRelationshipAction(target, id, isRelationshipLabel(value) ? value : null);
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  return { pending, error, change };
}

export function RelationshipSelect({
  relationship,
  pending,
  disabled,
  onChange,
  className,
}: {
  relationship: Relationship | null | undefined;
  pending: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <NativeSelect
      aria-label="Change relationship"
      value={relationship?.override?.label ?? ""}
      disabled={pending || disabled}
      onChange={(event) => onChange(event.target.value)}
      className={cn("h-[30px] w-auto text-[13px]", className)}
    >
      <option value="">Automatic</option>
      {RELATIONSHIP_LABELS.map((label) => (
        <option key={label} value={label}>
          {RELATIONSHIP_META[label].label}
        </option>
      ))}
    </NativeSelect>
  );
}

export function RelationshipSource({
  relationship,
  viewerId,
}: {
  relationship: Relationship | null | undefined;
  viewerId?: string | null;
}) {
  const override = relationship?.override;
  if (!override) return null;
  const who = override.byUserId && override.byUserId === viewerId ? "you" : (override.byName ?? "hand");
  const automatic = relationship.automatic ? ` Automatic: ${RELATIONSHIP_META[relationship.automatic.label].label}.` : "";
  return (
    <p className="caption-style text-subtle">
      Set by {who}
      {override.at ? ` on ${formatDate(override.at)}` : ""}.{automatic}
    </p>
  );
}

export function RelationshipError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="caption-style text-danger">
      {error}
    </p>
  );
}
