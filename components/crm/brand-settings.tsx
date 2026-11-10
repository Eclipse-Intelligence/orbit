"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { Textarea } from "@/components/_ui/textarea";
import { SettingsCard } from "@/components/crm/settings-ui";
import { draftBrandAction, saveBrandProfileAction } from "@/app/(crm)/settings/brand/actions";
import { BRAND_LIMITS, FORMER_NAME_LIMITS, type BrandProfile, type BrandProfileInput } from "@/lib/crm/brand-rules";
import { reloadIfStaleDeploy } from "@/lib/stale-deploy";
import { cn } from "@/lib/utils";

type FormValues = BrandProfileInput & { formerNames: string };
type Key = keyof FormValues;
type DraftKey = Exclude<keyof BrandProfileInput, "website">;
type Drafted = Partial<Record<DraftKey, string>>;

const LABELS: Record<DraftKey, string> = { whatYouSell: "What you sell", whoItsFor: "Ideal customer", tone: "Tone" };

function profileOf(brand: BrandProfile): FormValues {
  return { website: brand.website, whatYouSell: brand.whatYouSell, whoItsFor: brand.whoItsFor, tone: brand.tone, formerNames: brand.formerNames.join(", ") };
}

function same(left: FormValues, right: FormValues) {
  return (Object.keys(left) as Key[]).every((key) => left[key].trim() === right[key].trim());
}

export default function BrandSettings({ brand, canEdit, learned }: { brand: BrandProfile; canEdit: boolean; learned: string | null }) {
  const router = useRouter();
  const [saved, setSaved] = useState(() => profileOf(brand));
  const [values, setValues] = useState(() => profileOf(brand));
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "draft" | null>(null);
  const [replace, setReplace] = useState<Drafted | null>(null);
  const latestValues = useRef(values);
  const dirty = !same(values, saved);
  const busy = pending !== null;

  useEffect(() => {
    latestValues.current = values;
  }, [values]);

  function update(key: Key, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setError(null);
    setStatus(null);
  }

  function fail(message: string, field?: string) {
    if (field && field in values) setErrors({ [field]: message });
    else setError(message);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("save");
    setError(null);
    setStatus(null);
    setReplace(null);
    try {
      const result = await saveBrandProfileAction(values);
      if (result.error || !result.saved) {
        fail(result.error ?? "Couldn't save. Try again.", result.field);
        return;
      }
      const next = profileOf(result.saved);
      setSaved(next);
      setValues(next);
      setStatus("Saved");
      router.refresh();
    } catch (problem) {
      if (!reloadIfStaleDeploy(problem)) setError("Couldn't save. Try again.");
    } finally {
      setPending(null);
    }
  }

  async function draft() {
    setPending("draft");
    setError(null);
    setReplace(null);
    setStatus("Reading the website (up to a minute)");
    try {
      const result = await draftBrandAction({ website: values.website });
      if (result.error || !result.draft) {
        setStatus(null);
        fail(result.error ?? "Couldn't draft. Try again.", result.field);
        return;
      }
      const { draft: drafted, notes } = result.draft;
      const keys = Object.keys(LABELS) as (keyof Drafted)[];
      const latest = latestValues.current;
      const conflicts: Drafted = {};
      for (const key of keys) {
        const text = drafted[key].trim();
        if (text && latest[key].trim() && latest[key].trim() !== text) conflicts[key] = text;
      }
      setValues((current) => {
        const filled: Drafted = {};
        for (const key of keys) {
          const text = drafted[key].trim();
          if (text && !current[key].trim()) filled[key] = text;
        }
        return { ...current, ...filled };
      });
      const differing = keys.filter((key) => conflicts[key]);
      const extra = notes.length ? ` ${notes.join(" ")}` : "";
      if (differing.length) {
        setReplace(conflicts);
        setStatus(`Drafted. ${differing.map((key) => LABELS[key]).join(" and ")} differ from what you wrote.${extra}`);
      } else {
        setStatus(`Drafted. Check it, then save.${extra}`);
      }
    } catch (problem) {
      setStatus(null);
      if (!reloadIfStaleDeploy(problem)) setError("Couldn't draft. Try again.");
    } finally {
      setPending(null);
    }
  }

  function useDraft() {
    if (!replace) return;
    setValues((current) => ({ ...current, ...replace }));
    setReplace(null);
    setStatus(null);
  }

  return (
    <>
      <SettingsCard id="brand-profile" title="Brand profile">
        <form className="flex flex-col gap-4" noValidate onSubmit={save}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label="Website" htmlFor="brand-website" error={errors.website} className="flex-1">
              <Input
                id="brand-website"
                type="url"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                maxLength={BRAND_LIMITS.website}
                value={values.website}
                placeholder="yourcompany.com"
                readOnly={!canEdit}
                aria-invalid={errors.website ? true : undefined}
                aria-describedby={errors.website ? "brand-website-error" : undefined}
                onChange={(event) => update("website", event.target.value)}
              />
            </Field>
            {canEdit && (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                className={cn("h-9 self-start sm:self-auto", errors.website && "sm:mb-6")}
                disabled={busy || !values.website.trim()}
                onClick={() => void draft()}
              >
                {pending === "draft" ? "Drafting…" : "Draft from website"}
              </Button>
            )}
          </div>
          <Field label="What you sell" htmlFor="brand-sell" error={errors.whatYouSell}>
            <Textarea
              id="brand-sell"
              rows={3}
              maxLength={BRAND_LIMITS.whatYouSell}
              value={values.whatYouSell}
              readOnly={!canEdit || pending === "draft"}
              aria-invalid={errors.whatYouSell ? true : undefined}
              aria-describedby={errors.whatYouSell ? "brand-sell-error" : undefined}
              onChange={(event) => update("whatYouSell", event.target.value)}
              className="field-sizing-content max-h-[24em]"
            />
          </Field>
          <Field
            label="Ideal customer"
            htmlFor="brand-who"
            error={errors.whoItsFor}
            hint="Size, sector, trigger and who signs. Web checks score companies against this."
            trailing={
              canEdit && learned && learned !== values.whoItsFor.trim() ? (
                <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={() => update("whoItsFor", learned)}>
                  Use what Orbit learned
                </Button>
              ) : undefined
            }
          >
            <Textarea
              id="brand-who"
              rows={3}
              maxLength={BRAND_LIMITS.whoItsFor}
              value={values.whoItsFor}
              readOnly={!canEdit || pending === "draft"}
              aria-invalid={errors.whoItsFor ? true : undefined}
              aria-describedby={errors.whoItsFor ? "brand-who-error" : "brand-who-hint"}
              onChange={(event) => update("whoItsFor", event.target.value)}
              className="field-sizing-content max-h-[24em]"
            />
          </Field>
          <Field label="Tone" htmlFor="brand-tone" error={errors.tone} hint="Adds to How you write in Settings › General.">
            <Textarea
              id="brand-tone"
              rows={2}
              maxLength={BRAND_LIMITS.tone}
              value={values.tone}
              readOnly={!canEdit || pending === "draft"}
              aria-invalid={errors.tone ? true : undefined}
              aria-describedby={errors.tone ? "brand-tone-error" : "brand-tone-hint"}
              onChange={(event) => update("tone", event.target.value)}
              className="field-sizing-content max-h-[24em]"
            />
          </Field>
          <Field
            label="Former names"
            htmlFor="brand-former"
            error={errors.formerNames}
            hint="Separated by commas."
          >
            <Input
              id="brand-former"
              spellCheck={false}
              maxLength={FORMER_NAME_LIMITS.count * (FORMER_NAME_LIMITS.length + 2)}
              value={values.formerNames}
              readOnly={!canEdit || pending === "draft"}
              aria-invalid={errors.formerNames ? true : undefined}
              aria-describedby={errors.formerNames ? "brand-former-error" : "brand-former-hint"}
              onChange={(event) => update("formerNames", event.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className="caption-style text-danger">
              {error}
            </p>
          )}
          {canEdit ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" size="sm" type="submit" disabled={busy || !dirty}>
                {pending === "save" ? "Saving…" : "Save"}
              </Button>
              {replace && !busy && (
                <>
                  <Button variant="secondary" size="sm" type="button" onClick={useDraft}>
                    Use draft
                  </Button>
                  <Button variant="ghost" size="sm" type="button" onClick={() => setReplace(null)}>
                    Keep mine
                  </Button>
                </>
              )}
              {dirty && !busy && !replace && (
                <Button variant="ghost" size="sm" type="button" onClick={() => setValues(saved)}>
                  Undo
                </Button>
              )}
              <p role="status" className="caption-style text-subtle">
                {status}
              </p>
            </div>
          ) : (
            <p className="caption-style text-subtle">Only owners and admins can change the brand.</p>
          )}
        </form>
      </SettingsCard>
    </>
  );
}
