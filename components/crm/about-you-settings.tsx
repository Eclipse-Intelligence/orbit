"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { SettingsCard } from "@/components/crm/settings-ui";
import { draftAboutYouAction, saveAboutYouAction } from "@/app/(crm)/settings/actions";
import { PERSONAL_LIMITS, type PersonalContextInput } from "@/lib/personal-context-rules";
import { textareaClass } from "@/components/_ui/field-styles";

type Key = keyof PersonalContextInput;

const AREA = textareaClass;

function same(left: PersonalContextInput, right: PersonalContextInput) {
  return (Object.keys(left) as Key[]).every((key) => left[key].trim() === right[key].trim());
}

type WorkspaceAbout = { name: string; about: string; jobTitle: string };

type ScopedKey = "workspaceAbout" | "workspaceJobTitle";

export default function AboutYouSettings({ initial, workspace = null }: { initial: PersonalContextInput; workspace?: WorkspaceAbout | null }) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState(initial);
  const startScoped = { about: workspace?.about ?? "", jobTitle: workspace?.jobTitle ?? "" };
  const [savedScoped, setSavedScoped] = useState(startScoped);
  const [scoped, setScoped] = useState(startScoped);
  const [errors, setErrors] = useState<Partial<Record<Key | ScopedKey, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "draft" | null>(null);
  const scopedDirty = Boolean(workspace) && (scoped.about.trim() !== savedScoped.about.trim() || scoped.jobTitle.trim() !== savedScoped.jobTitle.trim());
  const dirty = !same(values, saved) || scopedDirty;

  function update(key: Key, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setError(null);
    setStatus(null);
  }

  function updateScoped(key: "about" | "jobTitle", value: string) {
    setScoped((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key === "about" ? "workspaceAbout" : "workspaceJobTitle"]: undefined }));
    setError(null);
    setStatus(null);
  }

  function fail(message: string, field?: string) {
    if (field && (field in values || field === "workspaceAbout" || field === "workspaceJobTitle")) setErrors({ [field]: message });
    else setError(message);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("save");
    setError(null);
    setStatus(null);
    const result = await saveAboutYouAction(workspace ? { ...values, workspaceAbout: scoped.about, workspaceJobTitle: scoped.jobTitle } : values);
    setPending(null);
    if (result.error || !result.saved) {
      fail(result.error ?? "Could not save About you.", result.field);
      return;
    }
    const next = {
      jobTitle: result.saved.jobTitle,
      about: result.saved.about,
      interests: result.saved.interests,
      writing: result.saved.writing,
      linkedinUrl: result.saved.linkedinUrl,
      websiteUrl: result.saved.websiteUrl,
    };
    setSaved(next);
    setValues(next);
    const nextScoped = { about: result.saved.workspaceAbout, jobTitle: result.saved.workspaceJobTitle };
    setSavedScoped(nextScoped);
    setScoped(nextScoped);
    setStatus("Saved. The assistant uses this from your next message.");
    router.refresh();
  }

  async function draft() {
    setPending("draft");
    setError(null);
    setStatus("Reading your LinkedIn and website. This takes up to a minute.");
    const result = await draftAboutYouAction({ linkedinUrl: values.linkedinUrl, websiteUrl: values.websiteUrl });
    setPending(null);
    if (result.error || !result.draft) {
      setStatus(null);
      fail(result.error ?? "Could not draft About you.", result.field);
      return;
    }
    const { draft: drafted, notes } = result.draft;
    setValues((current) => ({
      ...current,
      jobTitle: drafted.jobTitle || current.jobTitle,
      about: drafted.about || current.about,
      interests: drafted.interests || current.interests,
      writing: drafted.writing || current.writing,
    }));
    setStatus(`Drafted. Check it, change anything that isn't right, then save.${notes.length ? ` ${notes.join(" ")}` : ""}`);
  }

  const busy = pending !== null;

  return (
    <SettingsCard
      id="about-you"
      title="About you"
      description="Orbit's assistant reads this so it knows who it's helping, and Mail uses it when drafting for you. Your role is shown to your workspace. Everything else is private to you."
    >
      <form className="flex flex-col gap-4" noValidate onSubmit={save}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="LinkedIn profile" htmlFor="about-linkedin" error={errors.linkedinUrl}>
            <Input
              id="about-linkedin"
              type="url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              maxLength={PERSONAL_LIMITS.url}
              value={values.linkedinUrl}
              placeholder="linkedin.com/in/your-name"
              aria-invalid={errors.linkedinUrl ? true : undefined}
              aria-describedby={errors.linkedinUrl ? "about-linkedin-error" : undefined}
              onChange={(event) => update("linkedinUrl", event.target.value)}
            />
          </Field>
          <Field label="Website" htmlFor="about-website" error={errors.websiteUrl}>
            <Input
              id="about-website"
              type="url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              maxLength={PERSONAL_LIMITS.url}
              value={values.websiteUrl}
              placeholder="yourname.com"
              aria-invalid={errors.websiteUrl ? true : undefined}
              aria-describedby={errors.websiteUrl ? "about-website-error" : undefined}
              onChange={(event) => update("websiteUrl", event.target.value)}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={busy || (!values.linkedinUrl.trim() && !values.websiteUrl.trim())}
            onClick={() => void draft()}
          >
            {pending === "draft" ? "Drafting…" : "Draft from my LinkedIn and website"}
          </Button>
          <span className="caption-style text-subtle">Fills in the fields below for you to check. Nothing is saved until you save.</span>
        </div>
        <Field label="Your role" htmlFor="about-role" error={errors.jobTitle} hint="Shown to your workspace.">
          <Input
            id="about-role"
            autoComplete="organization-title"
            maxLength={PERSONAL_LIMITS.jobTitle}
            value={values.jobTitle}
            placeholder="Founder and CEO, Acme"
            aria-invalid={errors.jobTitle ? true : undefined}
            aria-describedby={errors.jobTitle ? "about-role-error" : "about-role-hint"}
            onChange={(event) => update("jobTitle", event.target.value)}
          />
        </Field>
        <Field
          label="About you"
          htmlFor="about-about"
          error={errors.about}
          hint={`What you do, what you're responsible for and who you work with. ${values.about.length}/${PERSONAL_LIMITS.about}`}
        >
          <textarea
            id="about-about"
            rows={4}
            maxLength={PERSONAL_LIMITS.about}
            value={values.about}
            aria-invalid={errors.about ? true : undefined}
            aria-describedby={errors.about ? "about-about-error" : "about-about-hint"}
            onChange={(event) => update("about", event.target.value)}
            className={AREA}
          />
        </Field>
        <Field
          label="What you care about"
          htmlFor="about-interests"
          error={errors.interests}
          hint={`Your interests, and the views you hold and are known for. ${values.interests.length}/${PERSONAL_LIMITS.interests}`}
        >
          <textarea
            id="about-interests"
            rows={5}
            maxLength={PERSONAL_LIMITS.interests}
            value={values.interests}
            aria-invalid={errors.interests ? true : undefined}
            aria-describedby={errors.interests ? "about-interests-error" : "about-interests-hint"}
            onChange={(event) => update("interests", event.target.value)}
            className={AREA}
          />
        </Field>
        <Field
          label="How you write"
          htmlFor="about-writing"
          error={errors.writing}
          hint={`Tone, length, how you open and sign off, words you'd never use. ${values.writing.length}/${PERSONAL_LIMITS.writing}`}
        >
          <textarea
            id="about-writing"
            rows={3}
            maxLength={PERSONAL_LIMITS.writing}
            value={values.writing}
            aria-invalid={errors.writing ? true : undefined}
            aria-describedby={errors.writing ? "about-writing-error" : "about-writing-hint"}
            onChange={(event) => update("writing", event.target.value)}
            className={AREA}
          />
        </Field>
        {workspace && (
          <div className="border-border flex flex-col gap-4 border-t pt-4">
            <div className="flex flex-col gap-1">
              <h3>About you in {workspace.name}</h3>
              <p className="caption-style text-subtle">Used instead of your role and About you when Orbit writes for {workspace.name}. Leave empty to use the ones above.</p>
            </div>
            <Field label={`Your role in ${workspace.name}`} htmlFor="about-workspace-role" error={errors.workspaceJobTitle}>
              <Input
                id="about-workspace-role"
                autoComplete="off"
                maxLength={PERSONAL_LIMITS.jobTitle}
                value={scoped.jobTitle}
                placeholder={values.jobTitle || "Founder and CEO, Acme"}
                aria-invalid={errors.workspaceJobTitle ? true : undefined}
                aria-describedby={errors.workspaceJobTitle ? "about-workspace-role-error" : undefined}
                onChange={(event) => updateScoped("jobTitle", event.target.value)}
              />
            </Field>
            <Field
              label={`About you in ${workspace.name}`}
              htmlFor="about-workspace-about"
              error={errors.workspaceAbout}
              hint={`${scoped.about.length}/${PERSONAL_LIMITS.about}`}
            >
              <textarea
                id="about-workspace-about"
                rows={4}
                maxLength={PERSONAL_LIMITS.about}
                value={scoped.about}
                aria-invalid={errors.workspaceAbout ? true : undefined}
                aria-describedby={errors.workspaceAbout ? "about-workspace-about-error" : "about-workspace-about-hint"}
                onChange={(event) => updateScoped("about", event.target.value)}
                className={AREA}
              />
            </Field>
          </div>
        )}
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="sm" type="submit" disabled={busy || !dirty}>
            {pending === "save" ? "Saving…" : "Save About you"}
          </Button>
          {dirty && !busy && (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                setValues(saved);
                setScoped(savedScoped);
              }}
            >
              Undo changes
            </Button>
          )}
          <p role="status" className="caption-style text-subtle">
            {status}
          </p>
        </div>
      </form>
    </SettingsCard>
  );
}
