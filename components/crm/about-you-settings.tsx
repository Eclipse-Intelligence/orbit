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
import { GENERIC_ERROR } from "@/lib/utils";

type Pending = "save" | "draft" | null;
type ProfileField = keyof AboutYouInput | keyof YouInput | "websiteUrl";
type FieldErrors = Partial<Record<ProfileField, string>>;

function same<T extends Record<string, string>>(left: T, right: T) {
  return Object.keys(left).every((key) => left[key].trim() === right[key].trim());
}

function describedBy(id: string, error: string | undefined) {
  return error ? `${id}-error` : `${id}-hint`;
}

function SaveRow({
  pending,
  busy,
  dirty,
  error,
  status,
  onUndo,
}: {
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
          {pending ? "Saving…" : "Save"}
        </Button>
        {dirty && !busy && (
          <Button variant="ghost" size="sm" type="button" onClick={onUndo}>
            Undo
          </Button>
        )}
        <p role="status" className="caption-style text-subtle">
          {status}
        </p>
      </div>
    </>
  );
}

function DraftButton({ pending, disabled, describedBy, onDraft }: { pending: boolean; disabled: boolean; describedBy?: string; onDraft: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="secondary" size="sm" type="button" disabled={disabled} aria-describedby={describedBy} onClick={onDraft}>
        {pending ? "Drafting…" : "Draft from LinkedIn and website"}
      </Button>
    </div>
  );
}

function RoleField({ value, error, onChange }: { value: string; error?: string; onChange: (value: string) => void }) {
  return (
    <Field label="Your role" htmlFor="about-role" error={error} hint="Shown to your team.">
      <Input
        id="about-role"
        autoComplete="organization-title"
        maxLength={PERSONAL_LIMITS.jobTitle}
        value={value}
        placeholder="Founder and CEO, Acme"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy("about-role", error)}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function AboutField({ value, error, hint, onChange }: { value: string; error?: string; hint: string; onChange: (value: string) => void }) {
  return (
    <Field label="About you" htmlFor="about-about" error={error} hint={hint}>
      <Textarea
        id="about-about"
        rows={4}
        maxLength={PERSONAL_LIMITS.about}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy("about-about", error)}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function WebsiteField({ value, error, onChange }: { value: string; error?: string; onChange: (value: string) => void }) {
  return (
    <Field label="Website" htmlFor="about-website" error={error} hint="Read when drafting. Not saved.">
      <Input
        id="about-website"
        type="url"
        inputMode="url"
        autoComplete="url"
        spellCheck={false}
        maxLength={PERSONAL_LIMITS.url}
        value={value}
        placeholder="yourcompany.com"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy("about-website", error)}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function LinkedinField({ value, error, onChange }: { value: string; error?: string; onChange: (value: string) => void }) {
  return (
    <Field label="LinkedIn profile" htmlFor="about-linkedin" error={error}>
      <Input
        id="about-linkedin"
        type="url"
        inputMode="url"
        autoComplete="url"
        spellCheck={false}
        maxLength={PERSONAL_LIMITS.url}
        value={value}
        placeholder="linkedin.com/in/your-name"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "about-linkedin-error" : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function WritingField({ value, error, onChange }: { value: string; error?: string; onChange: (value: string) => void }) {
  return (
    <Field label="How you write" htmlFor="about-writing" error={error} hint={`Tone, length, sign-off, words to avoid. ${value.length}/${PERSONAL_LIMITS.writing}`}>
      <Textarea
        id="about-writing"
        rows={3}
        maxLength={PERSONAL_LIMITS.writing}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy("about-writing", error)}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function InterestsField({ value, error, onChange }: { value: string; error?: string; onChange: (value: string) => void }) {
  return (
    <Field label="What you care about" htmlFor="about-interests" error={error} hint={`${value.length}/${PERSONAL_LIMITS.interests}`}>
      <Textarea
        id="about-interests"
        rows={5}
        maxLength={PERSONAL_LIMITS.interests}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy("about-interests", error)}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function draftedStatus(notes: string[]) {
  return `Drafted. Check it, then save.${notes.length ? ` ${notes.join(" ")}` : ""}`;
}

export function AboutYouSettings({
  about: initialAbout,
  linkedinUrl,
  website: initialWebsite,
}: {
  about: AboutYouInput;
  linkedinUrl: string;
  website: string;
}) {
  const router = useRouter();
  const [savedAbout, setSavedAbout] = useState(initialAbout);
  const [about, setAbout] = useState(initialAbout);
  const [website, setWebsite] = useState(initialWebsite);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [aboutError, setAboutError] = useState<string | null>(null);
  const [aboutStatus, setAboutStatus] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const aboutDirty = !same(about, savedAbout);
  const busy = pending !== null;

  function clear(key: ProfileField) {
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
    const result = await saveAboutYouAction(about).catch(() => ({ error: GENERIC_ERROR, field: undefined, saved: undefined }));
    setPending(null);
    if (result.error || !result.saved) {
      if (result.field === "jobTitle" || result.field === "about") setErrors({ [result.field]: result.error });
      else setAboutError(result.error ?? "Couldn't save.");
      return;
    }
    const next = { jobTitle: result.saved.jobTitle, about: result.saved.about };
    setSavedAbout(next);
    setAbout(next);
    setAboutStatus("Saved");
    router.refresh();
  }

  async function draft() {
    setPending("draft");
    setDraftError(null);
    setAboutError(null);
    setAboutStatus("This takes up to a minute.");
    const result = await draftAboutYouAction({ linkedinUrl, websiteUrl: website }).catch(() => ({ error: GENERIC_ERROR, field: undefined, draft: undefined }));
    setPending(null);
    if (result.error || !result.draft) {
      setAboutStatus(null);
      if (result.field === "linkedinUrl") setDraftError(result.error ?? "Check your LinkedIn link.");
      else if (result.field === "websiteUrl") setErrors({ websiteUrl: result.error });
      else setAboutError(result.error ?? "Couldn't draft. Try again.");
      return;
    }
    const { draft: drafted, notes } = result.draft;
    setAbout((current) => ({ jobTitle: drafted.jobTitle || current.jobTitle, about: drafted.about || current.about }));
    setAboutStatus(draftedStatus(notes));
  }

  return (
    <SettingsCard id="about-you" title="About you">
      <form className="flex flex-col gap-4" noValidate onSubmit={saveAbout}>
        <RoleField value={about.jobTitle} error={errors.jobTitle} onChange={(value) => updateAbout("jobTitle", value)} />
        <AboutField
          value={about.about}
          error={errors.about}
          hint={`Private to you. ${about.about.length}/${PERSONAL_LIMITS.about}`}
          onChange={(value) => updateAbout("about", value)}
        />
        <WebsiteField
          value={website}
          error={errors.websiteUrl}
          onChange={(value) => {
            setWebsite(value);
            clear("websiteUrl");
          }}
        />
        <DraftButton
          pending={pending === "draft"}
          disabled={busy || (!linkedinUrl.trim() && !website.trim())}
          describedBy={draftError ? "about-draft-error" : undefined}
          onDraft={() => void draft()}
        />
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
          pending={pending === "save"}
          busy={busy}
          dirty={aboutDirty}
          error={aboutError}
          status={aboutStatus}
          onUndo={() => setAbout(savedAbout)}
        />
      </form>
    </SettingsCard>
  );
}

export function YouSettings({ you: initialYou, website }: { you: YouInput; website: string }) {
  const router = useRouter();
  const [savedYou, setSavedYou] = useState(initialYou);
  const [you, setYou] = useState(initialYou);
  const [errors, setErrors] = useState<FieldErrors>({});
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
    const result = await saveYouAction(you).catch(() => ({ error: GENERIC_ERROR, field: undefined, saved: undefined }));
    setPending(null);
    if (result.error || !result.saved) {
      if (result.field && result.field in you) setErrors({ [result.field]: result.error });
      else setYouError(result.error ?? "Couldn't save.");
      return;
    }
    const next = { linkedinUrl: result.saved.linkedinUrl, interests: result.saved.interests, writing: result.saved.writing };
    setSavedYou(next);
    setYou(next);
    setYouStatus("Saved");
    router.refresh();
  }

  async function draft() {
    setPending("draft");
    setYouError(null);
    setYouStatus("This takes up to a minute.");
    const result = await draftAboutYouAction({ linkedinUrl: you.linkedinUrl, websiteUrl: website }).catch(() => ({ error: GENERIC_ERROR, field: undefined, draft: undefined }));
    setPending(null);
    if (result.error || !result.draft) {
      setYouStatus(null);
      if (result.field === "linkedinUrl") setErrors({ linkedinUrl: result.error });
      else setYouError(result.error ?? "Couldn't draft. Try again.");
      return;
    }
    const { draft: drafted, notes } = result.draft;
    setYou((current) => ({ ...current, interests: drafted.interests || current.interests, writing: drafted.writing || current.writing }));
    setYouStatus(draftedStatus(notes));
  }

  return (
    <SettingsCard id="you" title="You" description="Private to you.">
      <form className="flex flex-col gap-4" noValidate onSubmit={saveYou}>
        <LinkedinField value={you.linkedinUrl} error={errors.linkedinUrl} onChange={(value) => updateYou("linkedinUrl", value)} />
        <WritingField value={you.writing} error={errors.writing} onChange={(value) => updateYou("writing", value)} />
        <InterestsField value={you.interests} error={errors.interests} onChange={(value) => updateYou("interests", value)} />
        <DraftButton pending={pending === "draft"} disabled={busy || (!you.linkedinUrl.trim() && !website.trim())} onDraft={() => void draft()} />
        <SaveRow
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

export function ProfileSettings({
  about: initialAbout,
  you: initialYou,
  website: initialWebsite,
}: {
  about: AboutYouInput;
  you: YouInput;
  website: string;
}) {
  const router = useRouter();
  const [savedAbout, setSavedAbout] = useState(initialAbout);
  const [about, setAbout] = useState(initialAbout);
  const [savedYou, setSavedYou] = useState(initialYou);
  const [you, setYou] = useState(initialYou);
  const [website, setWebsite] = useState(initialWebsite);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const aboutDirty = !same(about, savedAbout);
  const youDirty = !same(you, savedYou);
  const busy = pending !== null;

  function touch(key: ProfileField) {
    setErrors((current) => ({ ...current, [key]: undefined }));
    setError(null);
    setStatus(null);
  }

  function updateAbout(key: keyof AboutYouInput, value: string) {
    setAbout((current) => ({ ...current, [key]: value }));
    touch(key);
  }

  function updateYou(key: keyof YouInput, value: string) {
    setYou((current) => ({ ...current, [key]: value }));
    touch(key);
  }

  function failed(result: { error?: string; field?: string }) {
    const field = result.field as ProfileField | undefined;
    if (field && (field in about || field in you)) setErrors({ [field]: result.error });
    else setError(result.error ?? "Couldn't save.");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("save");
    setError(null);
    setStatus(null);
    if (youDirty) {
      const result = await saveYouAction(you).catch(() => ({ error: GENERIC_ERROR, field: undefined, saved: undefined }));
      if (result.error || !result.saved) {
        setPending(null);
        failed(result);
        return;
      }
      const next = { linkedinUrl: result.saved.linkedinUrl, interests: result.saved.interests, writing: result.saved.writing };
      setSavedYou(next);
      setYou(next);
    }
    if (aboutDirty) {
      const result = await saveAboutYouAction(about).catch(() => ({ error: GENERIC_ERROR, field: undefined, saved: undefined }));
      if (result.error || !result.saved) {
        setPending(null);
        failed(result);
        router.refresh();
        return;
      }
      const next = { jobTitle: result.saved.jobTitle, about: result.saved.about };
      setSavedAbout(next);
      setAbout(next);
    }
    setPending(null);
    setStatus("Saved");
    router.refresh();
  }

  async function draft() {
    setPending("draft");
    setError(null);
    setStatus("This takes up to a minute.");
    const result = await draftAboutYouAction({ linkedinUrl: you.linkedinUrl, websiteUrl: website }).catch(() => ({ error: GENERIC_ERROR, field: undefined, draft: undefined }));
    setPending(null);
    if (result.error || !result.draft) {
      setStatus(null);
      if (result.field === "linkedinUrl" || result.field === "websiteUrl") setErrors({ [result.field]: result.error });
      else setError(result.error ?? "Couldn't draft. Try again.");
      return;
    }
    const { draft: drafted, notes } = result.draft;
    setAbout((current) => ({ jobTitle: drafted.jobTitle || current.jobTitle, about: drafted.about || current.about }));
    setYou((current) => ({ ...current, interests: drafted.interests || current.interests, writing: drafted.writing || current.writing }));
    setStatus(draftedStatus(notes));
  }

  return (
    <SettingsCard id="you" title="About you" description="Private to you, except your role.">
      <form className="flex flex-col gap-4" noValidate onSubmit={save}>
        <RoleField value={about.jobTitle} error={errors.jobTitle} onChange={(value) => updateAbout("jobTitle", value)} />
        <AboutField
          value={about.about}
          error={errors.about}
          hint={`${about.about.length}/${PERSONAL_LIMITS.about}`}
          onChange={(value) => updateAbout("about", value)}
        />
        <LinkedinField value={you.linkedinUrl} error={errors.linkedinUrl} onChange={(value) => updateYou("linkedinUrl", value)} />
        <WebsiteField
          value={website}
          error={errors.websiteUrl}
          onChange={(value) => {
            setWebsite(value);
            touch("websiteUrl");
          }}
        />
        <WritingField value={you.writing} error={errors.writing} onChange={(value) => updateYou("writing", value)} />
        <InterestsField value={you.interests} error={errors.interests} onChange={(value) => updateYou("interests", value)} />
        <DraftButton pending={pending === "draft"} disabled={busy || (!you.linkedinUrl.trim() && !website.trim())} onDraft={() => void draft()} />
        <SaveRow
          pending={pending === "save"}
          busy={busy}
          dirty={aboutDirty || youDirty}
          error={error}
          status={status}
          onUndo={() => {
            setAbout(savedAbout);
            setYou(savedYou);
          }}
        />
      </form>
    </SettingsCard>
  );
}
