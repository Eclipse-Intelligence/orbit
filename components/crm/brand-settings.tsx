"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { Textarea } from "@/components/_ui/textarea";
import { SettingsCard } from "@/components/crm/settings-ui";
import { draftBrandAction, saveBrandProfileAction } from "@/app/(crm)/settings/brand/actions";
import { BRAND_LIMITS, type BrandProfile, type BrandProfileInput } from "@/lib/crm/brand-rules";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { reloadIfStaleDeploy } from "@/lib/stale-deploy";
import { cn } from "@/lib/utils";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";

type Key = keyof BrandProfileInput;
type Drafted = Partial<Record<Exclude<Key, "website">, string>>;

const LABELS: Record<Exclude<Key, "website">, string> = { whatYouSell: "What you sell", whoItsFor: "Who it's for", tone: "How you write" };

function profileOf(brand: BrandProfile): BrandProfileInput {
  return { website: brand.website, whatYouSell: brand.whatYouSell, whoItsFor: brand.whoItsFor, tone: brand.tone };
}

function same(left: BrandProfileInput, right: BrandProfileInput) {
  return (Object.keys(left) as Key[]).every((key) => left[key].trim() === right[key].trim());
}

function shortDate(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }).format(new Date(iso));
}

function count(value: number, one: string, many: string) {
  return `${value} ${value === 1 ? one : many}`;
}

export default function BrandSettings({
  brand,
  canEdit,
  proofCount,
  knowledgeCount,
  multi,
}: {
  brand: BrandProfile;
  canEdit: boolean;
  proofCount: number;
  knowledgeCount: number;
  multi: boolean;
}) {
  const router = useRouter();
  const name = brand.workspaceName;
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
        fail(result.error ?? "Could not save the brand profile.", result.field);
        return;
      }
      const next = profileOf(result.saved);
      setSaved(next);
      setValues(next);
      setStatus("Saved. The assistant uses this from your next message.");
      router.refresh();
    } catch (problem) {
      if (!reloadIfStaleDeploy(problem)) setError("That didn't save. Try again.");
    } finally {
      setPending(null);
    }
  }

  async function draft() {
    setPending("draft");
    setError(null);
    setReplace(null);
    setStatus("Reading the website. This takes up to a minute.");
    try {
      const result = await draftBrandAction({ website: values.website });
      if (result.error || !result.draft) {
        setStatus(null);
        fail(result.error ?? "Could not draft from the website.", result.field);
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
        setStatus(
          `Drafted. Empty fields are filled in. The draft is different for ${differing.map((key) => LABELS[key]).join(" and ")}, which you've already written.${extra}`,
        );
      } else {
        setStatus(`Drafted. Check it, change anything that isn't right, then save.${extra}`);
      }
    } catch (problem) {
      setStatus(null);
      if (!reloadIfStaleDeploy(problem)) setError("The draft didn't come back. Try again.");
    } finally {
      setPending(null);
    }
  }

  function useDraft() {
    if (!replace) return;
    setValues((current) => ({ ...current, ...replace }));
    setReplace(null);
    setStatus("Replaced with the draft. Check it, then save.");
  }

  const rows = [
    {
      title: "Proof list",
      caption: proofCount ? `${count(proofCount, "client result", "client results")} the assistant may quote` : "No client results yet",
      action: "Open",
      href: `${SETTINGS_PATHS.knowledge}#proof`,
    },
    {
      title: "Cold email playbook",
      caption: brand.playbook.trim()
        ? `How first emails to prospects are researched and written.${brand.playbookUpdatedAt ? ` Edited ${shortDate(brand.playbookUpdatedAt)}.` : ""}`
        : "Not written yet. The assistant writes first emails from the brand profile.",
      action: canEdit ? "Edit" : "Open",
      href: `${SETTINGS_PATHS.brand}/playbook`,
    },
    {
      title: "Knowledge",
      caption: knowledgeCount ? count(knowledgeCount, "document or link", "documents and links") : "No documents or links yet",
      action: "Open",
      href: SETTINGS_PATHS.knowledge,
    },
  ];

  return (
    <>
      <SettingsCard
        id="brand-profile"
        title="Brand profile"
        description={
          multi
            ? `Used by the assistant in ${name} only. How you write, signatures and AI accounts are yours and stay the same in every workspace.`
            : "Used by the assistant whenever it writes, researches or drafts for the business."
        }
      >
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
          <Field
            label="What you sell"
            htmlFor="brand-sell"
            error={errors.whatYouSell}
            hint="Your offer, in a sentence or two. The assistant never pitches it back to a prospect who sells the same."
          >
            <Textarea
              id="brand-sell"
              rows={3}
              maxLength={BRAND_LIMITS.whatYouSell}
              value={values.whatYouSell}
              readOnly={!canEdit || pending === "draft"}
              aria-invalid={errors.whatYouSell ? true : undefined}
              aria-describedby={errors.whatYouSell ? "brand-sell-error" : "brand-sell-hint"}
              onChange={(event) => update("whatYouSell", event.target.value)}
              className="field-sizing-content max-h-[24em]"
            />
          </Field>
          <Field
            label="Who it's for"
            htmlFor="brand-who"
            error={errors.whoItsFor}
            hint="Your ideal customer: size, sector, trigger and who signs. Web checks score companies against this too."
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
          <Field label="How you write" htmlFor="brand-tone" error={errors.tone} hint={multi ? "Tone for email in this workspace. Adds to How you write in General." : "Tone for the business's email. Adds to How you write in General."}>
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
          {error && (
            <p role="alert" className="caption-style text-danger">
              {error}
            </p>
          )}
          {canEdit ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" size="sm" type="submit" disabled={busy || !dirty}>
                {pending === "save" ? "Saving…" : "Save brand profile"}
              </Button>
              {replace && !busy && (
                <>
                  <Button variant="secondary" size="sm" type="button" onClick={useDraft}>
                    Use the draft
                  </Button>
                  <Button variant="ghost" size="sm" type="button" onClick={() => setReplace(null)}>
                    Keep mine
                  </Button>
                </>
              )}
              {dirty && !busy && !replace && (
                <Button variant="ghost" size="sm" type="button" onClick={() => setValues(saved)}>
                  Undo changes
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

      <SettingsCard id="brand-material" title="Proof, playbook and Knowledge" description={multi ? `${name}'s own. Nothing here is shared with your other workspaces.` : undefined}>
        <ul className="-my-1 flex flex-col">
          {rows.map((row) => (
            <li key={row.title} className="border-border flex items-center gap-3 border-b py-3 last:border-b-0">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[14px] leading-5">{row.title}</span>
                <span className="caption-style text-subtle">{row.caption}</span>
              </span>
              <Button variant="secondary" size="sm" href={row.href} aria-label={`${row.action} ${row.title}`}>
                {row.action}
                <ChevronRightIcon aria-hidden className="text-subtle size-3" />
              </Button>
            </li>
          ))}
        </ul>
      </SettingsCard>
    </>
  );
}
