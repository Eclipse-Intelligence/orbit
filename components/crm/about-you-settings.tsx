"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { Textarea } from "@/components/_ui/textarea";
import { SettingsCard } from "@/components/crm/settings-ui";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { draftAboutYouAction, saveAboutYouAction, saveYouAction } from "@/app/(crm)/settings/actions";
import { PERSONAL_LIMITS, type AboutYouInput, type YouInput } from "@/lib/personal-context-rules";

type Pending = "save" | "draft" | null;

function same<T extends Record<string, string>>(left: T, right: T) {
  return Object.keys(left).every((key) => left[key].trim() === right[key].trim());
}

function SaveRow({
  label,
  pending,
  busy,
  dirty,
  error,
  status,
  onUndo,
}: {
  label: string;
  pending: boolean;
  busy: boolean;
  dirty: boolean;
  error: string | null;
  status: string | null;
  onUndo: () => void;
}) {
  return (
    <>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="sm" type="submit" disabled={busy || !dirty}>
          {pending ? "Saving…" : label}
        </Button>
        {dirty && !busy && (
          <Button variant="ghost" size="sm" type="button" onClick={onUndo}>
            Undo changes
          </Button>
        )}
        <p role="status" className="caption-style text-subtle">
          {status}
        </p>
      </div>
    </>
  );
}

export function AboutYouSettings({
  about: initialAbout,
  linkedinUrl,
  website: initialWebsite,
  workspaceName,
}: {
  about: AboutYouInput;
  linkedinUrl: string;
  website: string;
  workspaceName: string | null;
}) {
  const router = useRouter();
  const [savedAbout, setSavedAbout] = useState(initialAbout);
  const [about, setAbout] = useState(initialAbout);
  const [website, setWebsite] = useState(initialWebsite);
  const [errors, setErrors] = useState<Partial<Record<keyof AboutYouInput | "websiteUrl", string>>>({});
  const [aboutError, setAboutError] = useState<string | null>(null);
  const [aboutStatus, setAboutStatus] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const aboutDirty = !same(about, savedAbout);
  const busy = pending !== null;

  function clear(key: keyof AboutYouInput | "websiteUrl") {
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  function updateAbout(key: keyof AboutYouInput, value: string) {
    setAbout((current) => ({ ...current, [key]: value }));
    clear(key);
    setAboutError(null);
    setAboutStatus(null);
  }

  async function saveAbout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("save");
    setAboutError(null);
    setAboutStatus(null);
    const result = await saveAboutYouAction(about);
    setPending(null);
    if (result.error || !result.saved) {
      if (result.field === "jobTitle" || result.field === "about") setErrors({ [result.field]: result.error });
      else setAboutError(result.error ?? "Could not save About you.");
      return;
    }
    const next = { jobTitle: result.saved.jobTitle, about: result.saved.about };
    setSavedAbout(next);
    setAbout(next);
    setAboutStatus("Saved. The assistant uses this from your next message.");
    router.refresh();
  }

  async function draft() {
    setPending("draft");
    setDraftError(null);
    setAboutError(null);
    setAboutStatus("Reading your LinkedIn and website. This takes up to a minute.");
    const result = await draftAboutYouAction({ linkedinUrl, websiteUrl: website });
    setPending(null);
    if (result.error || !result.draft) {
      setAboutStatus(null);
      if (result.field === "linkedinUrl") setDraftError(result.error ?? "Check your LinkedIn link.");
      else if (result.field === "websiteUrl") setErrors({ websiteUrl: result.error });
      else setAboutError(result.error ?? "Could not draft About you.");
      return;
    }
    const { draft: drafted, notes } = result.draft;
    setAbout((current) => ({ jobTitle: drafted.jobTitle || current.jobTitle, about: drafted.about || current.about }));
    setAboutStatus(`Drafted. Check it, change anything that isn't right, then save.${notes.length ? ` ${notes.join(" ")}` : ""}`);
  }

  return (
    <SettingsCard
      id="about-you"
      title="About you"
      description={
        workspaceName
          ? `For ${workspaceName}. The assistant and Mail use it here. Your role is shown to your team in ${workspaceName}, and About you is private to you.`
          : "Orbit's assistant reads this so it knows who it's helping, and Mail uses it when drafting for you. Your role is shown to your team. About you is private to you."
      }
    >
      <form className="flex flex-col gap-4" noValidate onSubmit={saveAbout}>
        <Field label="Your role" htmlFor="about-role" error={errors.jobTitle} hint="Shown to your team.">
          <Input
            id="about-role"
            autoComplete="organization-title"
            maxLength={PERSONAL_LIMITS.jobTitle}
            value={about.jobTitle}
            placeholder="Founder and CEO, Acme"
            aria-invalid={errors.jobTitle ? true : undefined}
            aria-describedby={errors.jobTitle ? "about-role-error" : "about-role-hint"}
            onChange={(event) => updateAbout("jobTitle", event.target.value)}
          />
        </Field>
        <Field
          label="About you"
          htmlFor="about-about"
          error={errors.about}
          hint={`What you do, what you're responsible for and who you work with. ${about.about.length}/${PERSONAL_LIMITS.about}`}
        >
          <Textarea
            id="about-about"
            rows={4}
            maxLength={PERSONAL_LIMITS.about}
            value={about.about}
            aria-invalid={errors.about ? true : undefined}
            aria-describedby={errors.about ? "about-about-error" : "about-about-hint"}
            onChange={(event) => updateAbout("about", event.target.value)}
          />
        </Field>
        <Field label="Website" htmlFor="about-website" error={errors.websiteUrl} hint="Read when drafting. Not saved.">
          <Input
            id="about-website"
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            maxLength={PERSONAL_LIMITS.url}
            value={website}
            placeholder="yourcompany.com"
            aria-invalid={errors.websiteUrl ? true : undefined}
            aria-describedby={errors.websiteUrl ? "about-website-error" : "about-website-hint"}
            onChange={(event) => {
              setWebsite(event.target.value);
              clear("websiteUrl");
            }}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={busy || (!linkedinUrl.trim() && !website.trim())}
            aria-describedby={draftError ? "about-draft-caption about-draft-error" : "about-draft-caption"}
            onClick={() => void draft()}
          >
            {pending === "draft" ? "Drafting…" : "Draft from my LinkedIn and website"}
          </Button>
          <span id="about-draft-caption" className="caption-style text-subtle">
            Fills in this card for you to check. Nothing is saved until you save.
          </span>
        </div>
        {draftError && (
          <p id="about-draft-error" role="alert" className="caption-style text-danger">
            {draftError}{" "}
            <Button variant="link" size="none" href={`${SETTINGS_PATHS.general}#you`} className="caption-style">
              Change your LinkedIn link in General
            </Button>
            .
          </p>
        )}
        <SaveRow
          label="Save About you"
          pending={pending === "save"}
          busy={busy}
          dirty={aboutDirty}
          error={aboutError}
          status={aboutStatus}
          onUndo={() => setAbout(savedAbout)}
        />
        <p className="caption-style text-subtle">
          Your LinkedIn, how you write and what you care about are in{" "}
          <Button variant="link" size="none" href={`${SETTINGS_PATHS.general}#you`} className="caption-style">
            General
          </Button>
          .
        </p>
      </form>
    </SettingsCard>
  );
}

export function YouSettings({ you: initialYou, multi }: { you: YouInput; multi: boolean }) {
  const router = useRouter();
  const [savedYou, setSavedYou] = useState(initialYou);
  const [you, setYou] = useState(initialYou);
  const [errors, setErrors] = useState<Partial<Record<keyof YouInput, string>>>({});
  const [youError, setYouError] = useState<string | null>(null);
  const [youStatus, setYouStatus] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const youDirty = !same(you, savedYou);
  const busy = pending !== null;

  function updateYou(key: keyof YouInput, value: string) {
    setYou((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setYouError(null);
    setYouStatus(null);
  }

  async function saveYou(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("save");
    setYouError(null);
    setYouStatus(null);
    const result = await saveYouAction(you);
    setPending(null);
    if (result.error || !result.saved) {
      if (result.field && result.field in you) setErrors({ [result.field]: result.error });
      else setYouError(result.error ?? "Could not save.");
      return;
    }
    const next = { linkedinUrl: result.saved.linkedinUrl, interests: result.saved.interests, writing: result.saved.writing };
    setSavedYou(next);
    setYou(next);
    setYouStatus("Saved. The assistant uses this from your next message.");
    router.refresh();
  }

  async function draft() {
    setPending("draft");
    setYouError(null);
    setYouStatus("Reading your LinkedIn. This takes up to a minute.");
    const result = await draftAboutYouAction({ linkedinUrl: you.linkedinUrl, websiteUrl: "" });
    setPending(null);
    if (result.error || !result.draft) {
      setYouStatus(null);
      if (result.field === "linkedinUrl") setErrors({ linkedinUrl: result.error });
      else setYouError(result.error ?? "Could not draft from your LinkedIn.");
      return;
    }
    const { draft: drafted, notes } = result.draft;
    setYou((current) => ({ ...current, interests: drafted.interests || current.interests, writing: drafted.writing || current.writing }));
    setYouStatus(`Drafted. Check it, then save.${notes.length ? ` ${notes.join(" ")}` : ""}`);
  }

  return (
    <SettingsCard
      id="you"
      title="You"
      description={multi ? "The same in every workspace. Private to you, and used whenever Orbit writes for you." : "Private to you, and used whenever Orbit writes for you."}
    >
      <form className="flex flex-col gap-4" noValidate onSubmit={saveYou}>
        <Field label="LinkedIn profile" htmlFor="about-linkedin" error={errors.linkedinUrl}>
          <Input
            id="about-linkedin"
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            maxLength={PERSONAL_LIMITS.url}
            value={you.linkedinUrl}
            placeholder="linkedin.com/in/your-name"
            aria-invalid={errors.linkedinUrl ? true : undefined}
            aria-describedby={errors.linkedinUrl ? "about-linkedin-error" : undefined}
            onChange={(event) => updateYou("linkedinUrl", event.target.value)}
          />
        </Field>
        <Field
          label="How you write"
          htmlFor="about-writing"
          error={errors.writing}
          hint={`Tone, length, how you open and sign off, words you'd never use. ${you.writing.length}/${PERSONAL_LIMITS.writing}`}
        >
          <Textarea
            id="about-writing"
            rows={3}
            maxLength={PERSONAL_LIMITS.writing}
            value={you.writing}
            aria-invalid={errors.writing ? true : undefined}
            aria-describedby={errors.writing ? "about-writing-error" : "about-writing-hint"}
            onChange={(event) => updateYou("writing", event.target.value)}
          />
        </Field>
        <Field
          label="What you care about"
          htmlFor="about-interests"
          error={errors.interests}
          hint={`Your interests, and the views you hold and are known for. ${you.interests.length}/${PERSONAL_LIMITS.interests}`}
        >
          <Textarea
            id="about-interests"
            rows={5}
            maxLength={PERSONAL_LIMITS.interests}
            value={you.interests}
            aria-invalid={errors.interests ? true : undefined}
            aria-describedby={errors.interests ? "about-interests-error" : "about-interests-hint"}
            onChange={(event) => updateYou("interests", event.target.value)}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" type="button" disabled={busy || !you.linkedinUrl.trim()} onClick={() => void draft()}>
            {pending === "draft" ? "Drafting…" : "Draft from my LinkedIn"}
          </Button>
          <span className="caption-style text-subtle">Fills in how you write and what you care about for you to check.</span>
        </div>
        <SaveRow
          label="Save"
          pending={pending === "save"}
          busy={busy}
          dirty={youDirty}
          error={youError}
          status={youStatus}
          onUndo={() => setYou(savedYou)}
        />
      </form>
    </SettingsCard>
  );
}
