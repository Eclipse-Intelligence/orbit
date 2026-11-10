"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import Field from "@/components/_ui/field";
import { Textarea } from "@/components/_ui/textarea";
import { SettingsCard } from "@/components/crm/settings-ui";
import { saveBrandPlaybookAction } from "@/app/(crm)/settings/brand/actions";
import { BRAND_LIMITS, type BrandPlaybookInput, type BrandProfile } from "@/lib/crm/brand-rules";
import { reloadIfStaleDeploy } from "@/lib/stale-deploy";

function same(left: BrandPlaybookInput, right: BrandPlaybookInput) {
  return left.playbook.trim() === right.playbook.trim() && left.outreachBrief.trim() === right.outreachBrief.trim();
}

export default function PlaybookSettings({ brand, canEdit }: { brand: BrandProfile; canEdit: boolean }) {
  const router = useRouter();
  const [saved, setSaved] = useState<BrandPlaybookInput>({ playbook: brand.playbook, outreachBrief: brand.outreachBrief });
  const [values, setValues] = useState<BrandPlaybookInput>(saved);
  const [errors, setErrors] = useState<Partial<Record<keyof BrandPlaybookInput, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = !same(values, saved);

  function update(key: keyof BrandPlaybookInput, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setError(null);
    setStatus(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const result = await saveBrandPlaybookAction(values);
      if (result.error || !result.saved) {
        if (result.field === "playbook" || result.field === "outreachBrief") setErrors({ [result.field]: result.error });
        else setError(result.error ?? "Couldn't save. Try again.");
        return;
      }
      const next = { playbook: result.saved.playbook, outreachBrief: result.saved.outreachBrief };
      setSaved(next);
      setValues(next);
      setStatus("Saved");
      router.refresh();
    } catch (problem) {
      if (!reloadIfStaleDeploy(problem)) setError("Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsCard
      id="playbook"
      title="Cold email playbook"
      description="{{first_name}} and {{booking_url}} are filled in for whoever sends."
    >
      <form className="flex flex-col gap-4" noValidate onSubmit={save}>
        <Field
          label="Playbook"
          htmlFor="playbook-text"
          error={errors.playbook}
          hint={`Markdown. ${values.playbook.length.toLocaleString("en-GB")}/${BRAND_LIMITS.playbook.toLocaleString("en-GB")}`}
        >
          <Textarea
            id="playbook-text"
            rows={16}
            maxLength={BRAND_LIMITS.playbook}
            value={values.playbook}
            readOnly={!canEdit}
            placeholder="Research steps, angles, length, when not to send"
            aria-invalid={errors.playbook ? true : undefined}
            aria-describedby={errors.playbook ? "playbook-text-error" : "playbook-text-hint"}
            onChange={(event) => update("playbook", event.target.value)}
            className="min-h-[16em]"
          />
        </Field>
        <Field
          label="What you may say"
          htmlFor="playbook-brief"
          error={errors.outreachBrief}
          hint="Claims, offers and limits that drafts are checked against. Empty: uses What you sell."
        >
          <Textarea
            id="playbook-brief"
            rows={8}
            maxLength={BRAND_LIMITS.outreachBrief}
            value={values.outreachBrief}
            readOnly={!canEdit}
            aria-invalid={errors.outreachBrief ? true : undefined}
            aria-describedby={errors.outreachBrief ? "playbook-brief-error" : "playbook-brief-hint"}
            onChange={(event) => update("outreachBrief", event.target.value)}
            className="min-h-[10em]"
          />
        </Field>
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="sm" type="submit" disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save"}
            </Button>
            {dirty && !saving && (
              <Button variant="ghost" size="sm" type="button" onClick={() => setValues(saved)}>
                Undo
              </Button>
            )}
            <p role="status" className="caption-style text-subtle">
              {status}
            </p>
          </div>
        ) : (
          <p className="caption-style text-subtle">Only owners and admins can change the playbook.</p>
        )}
      </form>
    </SettingsCard>
  );
}
