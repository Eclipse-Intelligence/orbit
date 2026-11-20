"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { Textarea } from "@/components/_ui/textarea";
import { SettingsCard } from "@/components/crm/settings-ui";
import { saveBusinessDetailsAction } from "@/app/(crm)/settings/brand/actions";
import { BUSINESS_LIMITS, type BusinessDetails } from "@/lib/proposals/model";
import { reloadIfStaleDeploy } from "@/lib/stale-deploy";

type Key = keyof BusinessDetails;

function same(left: BusinessDetails, right: BusinessDetails) {
  return (Object.keys(left) as Key[]).every((key) => left[key].trim() === right[key].trim());
}

export default function BusinessDetailsSettings({ business, canEdit, workspaceName }: { business: BusinessDetails; canEdit: boolean; workspaceName: string | null }) {
  const router = useRouter();
  const [saved, setSaved] = useState(business);
  const [values, setValues] = useState(business);
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dirty = !same(values, saved);

  function update(key: Key, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setError(null);
    setStatus(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setStatus(null);
    try {
      const result = await saveBusinessDetailsAction(values);
      if (result.error || !result.saved) {
        const message = result.error ?? "Couldn't save. Try again.";
        if (result.field && result.field in values) setErrors({ [result.field]: message });
        else setError(message);
        return;
      }
      setSaved(result.saved);
      setValues(result.saved);
      setStatus("Saved");
      router.refresh();
    } catch (problem) {
      if (!reloadIfStaleDeploy(problem)) setError("Couldn't save. Try again.");
    } finally {
      setPending(false);
    }
  }

  function described(key: Key) {
    return errors[key] ? `business-${key}-error` : undefined;
  }

  return (
    <SettingsCard id="business-details" title="Business details" description={workspaceName ? `Shown on proposals. Only in ${workspaceName}.` : "Shown on proposals."}>
      <form className="flex flex-col gap-4" noValidate onSubmit={save}>
        <Field label="Business name" htmlFor="business-name" error={errors.name}>
          <Input
            id="business-name"
            autoComplete="organization"
            maxLength={BUSINESS_LIMITS.name}
            value={values.name}
            readOnly={!canEdit}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={described("name")}
            onChange={(event) => update("name", event.target.value)}
          />
        </Field>
        <Field label="Address" htmlFor="business-address" error={errors.address}>
          <Textarea
            id="business-address"
            rows={3}
            autoComplete="street-address"
            maxLength={BUSINESS_LIMITS.address}
            value={values.address}
            readOnly={!canEdit}
            aria-invalid={errors.address ? true : undefined}
            aria-describedby={described("address")}
            onChange={(event) => update("address", event.target.value)}
            className="field-sizing-content max-h-[12em]"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone" htmlFor="business-phone" error={errors.phone}>
            <Input
              id="business-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={BUSINESS_LIMITS.phone}
              value={values.phone}
              readOnly={!canEdit}
              aria-invalid={errors.phone ? true : undefined}
              aria-describedby={described("phone")}
              onChange={(event) => update("phone", event.target.value)}
            />
          </Field>
          <Field label="Email" htmlFor="business-email" error={errors.email}>
            <Input
              id="business-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              spellCheck={false}
              maxLength={BUSINESS_LIMITS.email}
              value={values.email}
              readOnly={!canEdit}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={described("email")}
              onChange={(event) => update("email", event.target.value)}
            />
          </Field>
        </div>
        <Field label="Website" htmlFor="business-website" error={errors.website}>
          <Input
            id="business-website"
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            maxLength={BUSINESS_LIMITS.website}
            value={values.website}
            placeholder="yourcompany.com"
            readOnly={!canEdit}
            aria-invalid={errors.website ? true : undefined}
            aria-describedby={described("website")}
            onChange={(event) => update("website", event.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="sm" type="submit" disabled={pending || !dirty}>
              {pending ? (
                "Saving…"
              ) : (
                <>
                  Save<span className="sr-only"> business details</span>
                </>
              )}
            </Button>
            {dirty && !pending && (
              <Button variant="ghost" size="sm" type="button" onClick={() => setValues(saved)}>
                Undo<span className="sr-only"> business details changes</span>
              </Button>
            )}
            <p role="status" className="caption-style text-subtle">
              {status}
            </p>
          </div>
        ) : (
          <p className="caption-style text-subtle">Only owners and admins can change the business details.</p>
        )}
      </form>
    </SettingsCard>
  );
}
