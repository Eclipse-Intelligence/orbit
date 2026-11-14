"use client";

import { useEffect, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import Button, { buttonVariants } from "@/components/_ui/button";
import CopyButton from "@/components/_ui/copy-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import Tag from "@/components/_ui/tag";
import { Monogram } from "@/components/beautifui/record-marks";
import { askOrbit } from "@/components/assistant/ask-orbit";
import { UseTemplateButton } from "@/components/crm/email-template-picker";
import FindDetailButton from "@/components/crm/find-detail";
import { useFindAvailability } from "@/components/crm/find-availability";
import type { InvitePrefill } from "@/components/crm/invite-dialog";
import { SearchChip } from "@/components/crm/task-pad";
import { relinkChange, relinkNote } from "@/lib/task-pad";
import { TaskRecordLink } from "@/components/crm/task-workspace";
import { useComposer } from "@/components/mail/compose-dock";
import { relinkTaskAction, taskContextAction, taskInviteSetupAction } from "@/app/(crm)/task-act";
import { renderTemplate, type EmailTemplate } from "@/lib/crm/email-template-rules";
import { companyHref, contactHref, dealHref } from "@/lib/crm/hrefs";
import type { InviteSetup } from "@/lib/crm/invites";
import type { LinkChange, TaskContext, TaskPerson } from "@/lib/crm/task-act";
import type { LookupState } from "@/lib/enrichment/contacts";
import { taskKind, type TaskKind } from "@/lib/crm/task-kind";
import type { TitleHere } from "@/lib/crm/task-title";
import type { Task } from "@/lib/crm/types";
import { threadHref } from "@/lib/mail/view";
import { normalizePhone, teamsCallUrl } from "@/lib/phone";
import { appTimeZone } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useTaskPreparations } from "@/stores/task-preparation-store";
import MoreIcon from "@/public/assets/images/_common/more.svg";
import PhoneIcon from "@/public/assets/images/_common/phone.svg";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";
import SparkleIcon from "@/public/assets/images/assistant/sparkle.svg";
import OpportunityIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import MailIcon from "@/public/assets/images/mail/mail-open.svg";
import ReplyIcon from "@/public/assets/images/mail/reply.svg";
import UserIcon from "@/public/assets/images/tasks/user.svg";

const InviteDialog = dynamic(() => import("@/components/crm/invite-dialog"), { ssr: false });

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const ACTION = "hit";
const ICON_ACTION = "hit size-[34px]";
const PILL = "hit h-[30px] px-3.5 text-[14px]";
const TYPE_LABELS: Record<string, string> = { call: "Call", email: "Email", meeting: "Meeting", note: "Note", research: "Research", linkedin: "LinkedIn", agent_update: "Agent update", other: "Activity" };
const DAY = new Map<string, Intl.DateTimeFormat>();

function shortDate(value: string) {
  const date = new Date(value);
  const timeZone = appTimeZone();
  const year = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric" });
  const sameYear = year.format(date) === year.format(new Date());
  const key = `${timeZone}|${sameYear}`;
  let format = DAY.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
    DAY.set(key, format);
  }
  return format.format(date);
}

function money(value: string | null, currency: string) {
  const amount = Number(value);
  if (!value || !Number.isFinite(amount)) return null;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${value}`;
  }
}

function firstNameOf(task: Task) {
  return task.contactFirstName ?? task.contactName?.split(/\s+/)[0] ?? task.companyName ?? "them";
}

function useTaskContext(task: Task) {
  const key = `${task.id}|${task.updatedAt}|${task.contactId}|${task.contactEmail}|${task.contactPhone}|${task.companyId}|${task.opportunityId}`;
  const [state, setState] = useState<{ key: string; context: TaskContext | null; error: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const requestedAt = Date.now();
    void taskContextAction(task.id)
      .catch(() => ({ error: "Couldn't load the details. Try again." }))
      .then((result) => {
        if (cancelled) return;
        const context = "context" in result && result.context ? result.context : null;
        if (context) useTaskPreparations.getState().loaded(task.id, context.preparation, requestedAt);
        setState({ key, context, error: result.error ?? null });
      });
    return () => {
      cancelled = true;
    };
  }, [key, task.id]);
  const fresh = state?.key === key ? state : null;
  return { context: fresh?.context ?? null, error: fresh?.error ?? null, loading: !fresh };
}

export function callable(phone: string | null | undefined): phone is string {
  return Boolean(phone && /\d/.test(phone));
}

function CallLink({ phone, label, spoken, primary, iconOnly }: { phone: string; label: string; spoken: string; primary: boolean; iconOnly?: boolean }) {
  const teams = teamsCallUrl(phone);
  const tel = `tel:${normalizePhone(phone) ?? phone.replace(/[^\d+]/g, "")}`;
  const variant = primary ? "primary" : "secondary";
  const shape = iconOnly ? cn(buttonVariants({ variant, size: "icon" }), ICON_ACTION) : cn(buttonVariants({ variant, size: "md" }), ACTION);
  return (
    <>
      <a
        href={teams ?? tel}
        title={teams ? `${label} in Teams` : label}
        aria-label={teams ? `${spoken} in Teams` : spoken}
        className={cn(shape, "[@media(pointer:coarse)]:hidden")}
      >
        <PhoneIcon aria-hidden className="size-3.5" />
        {!iconOnly && (
          <>
            {label}
            {teams && <span className="font-normal opacity-60">Teams</span>}
          </>
        )}
      </a>
      <a href={tel} aria-label={spoken} className={cn(shape, "hidden [@media(pointer:coarse)]:inline-flex")}>
        <PhoneIcon aria-hidden className="size-3.5" />
        {!iconOnly && label}
      </a>
    </>
  );
}

type Actions = {
  task: Task;
  context: TaskContext | null;
  kind: TaskKind;
};

function findText(task: Task, needs: { phone: boolean; email: boolean }) {
  const what = needs.phone && needs.email ? "a phone number and email address" : needs.phone ? "a phone number" : "an email address";
  const name = task.contactName ?? "this contact";
  return `Find ${what} for ${name}${task.companyName ? ` at ${task.companyName}` : ""} and save it on the contact.`;
}

function findable(available: boolean, lookup: LookupState | undefined) {
  return available && lookup?.status !== "not_found";
}

function ContactActions({ task, context, kind }: Actions) {
  const router = useRouter();
  const composer = useComposer();
  const find = useFindAvailability();
  const [invite, setInvite] = useState<{ setup: InviteSetup; at: number } | null>(null);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = task.contactName ?? "";
  const first = firstNameOf(task);
  const phone = callable(task.contactPhone) ? task.contactPhone : null;
  const email = task.contactEmail;
  const thread = context?.thread ?? null;
  const booking = context?.bookingUrl ?? null;
  const to = email ? [{ address: email.toLowerCase(), name: name || null }] : [];
  const lead: TaskKind = kind === "todo" ? "call" : kind;
  const askPhone = !phone && !findable(find.phone, context?.lookups.phone);
  const askEmail = !email && !findable(find.email, context?.lookups.email);

  function ask() {
    if (!askOrbit(findText(task, { phone: !phone, email: !email }))) composer.showToast({ message: "Ask Orbit isn't available here.", tone: "alert" });
  }

  function compose(template?: EmailTemplate) {
    if (!email) return;
    if (!template) {
      composer.openComposer({ to });
      return;
    }
    const rendered = renderTemplate(template, {
      id: task.contactId ?? "none",
      firstName: task.contactFirstName,
      lastName: task.contactLastName,
      name,
      email,
      company: task.companyName,
    });
    composer.openComposer({ to, subject: rendered.subject, body: rendered.body });
  }

  async function openInvite() {
    if (inviting) return;
    setInviting(true);
    setError(null);
    const result = await taskInviteSetupAction().catch(() => ({ error: "Couldn't open the invite. Try again." }));
    setInviting(false);
    if ("setup" in result && result.setup) setInvite({ setup: result.setup, at: Date.now() });
    else setError(result.error ?? "Couldn't open the invite. Try again.");
  }

  function copy(text: string, message: string) {
    void navigator.clipboard
      .writeText(text)
      .then(() => composer.showToast({ message }))
      .catch(() => composer.showToast({ message: "Couldn't copy. Try again.", tone: "alert" }));
  }

  const prefill: InvitePrefill = { guests: email ? [{ email, name: name || null, contactId: task.contactId, company: task.companyName }] : [] };
  const buttons: ReactNode[] = [];
  const more: { key: string; label: string; icon: Icon; run: () => void }[] = [];
  const callButton = (primary: boolean, iconOnly = false) =>
    phone ? <CallLink key="call" phone={phone} label="Call" spoken={`Call ${first}`} primary={primary} iconOnly={iconOnly} /> : null;
  const emailButton = (primary: boolean) =>
    email ? (
      <Button key="email" variant={primary ? "primary" : "secondary"} size="md" onClick={() => compose()} className={ACTION}>
        <MailIcon aria-hidden className="size-3.5" />
        Email {first}
      </Button>
    ) : null;
  const replyButton = thread ? (
    <Button key="reply" variant="secondary" size="md" href={threadHref(thread.key, "reply")} title={thread.subject ?? undefined} className={ACTION}>
      <ReplyIcon aria-hidden className="size-3.5" />
      Reply on thread
    </Button>
  ) : null;
  const templateButton = (compact: boolean) =>
    email ? (
      <UseTemplateButton key="template" compact={compact} shortcut={false} onPick={(template) => compose(template)} className={compact ? ICON_ACTION : PILL} />
    ) : null;
  const inviteButton = (
    <Button key="invite" variant="primary" size="md" disabled={inviting} aria-busy={inviting || undefined} onClick={() => void openInvite()} className={ACTION}>
      <CalendarIcon aria-hidden className="size-3.5" />
      Invite
    </Button>
  );
  const bookingButton = booking ? <CopyButton key="booking" text={booking} label="Copy booking link" ariaLabel="Copy booking link" className={PILL} /> : null;

  if (lead === "call") {
    buttons.push(callButton(kind === "call"));
    if (phone) buttons.push(<CopyButton key="copy" text={phone} label="Copy" ariaLabel={`Copy ${first}'s number`} className={PILL} />);
    buttons.push(emailButton(false), templateButton(true));
    if (thread) more.push({ key: "reply", label: "Reply on thread", icon: ReplyIcon, run: () => router.push(threadHref(thread.key, "reply")) });
    if (email) more.push({ key: "invite", label: "Invite", icon: CalendarIcon, run: () => void openInvite() });
    if (booking) more.push({ key: "booking", label: "Copy booking link", icon: CalendarIcon, run: () => copy(booking, "Booking link copied.") });
  } else if (lead === "email") {
    buttons.push(emailButton(true), replyButton, templateButton(false));
    if (phone) buttons.push(callButton(false, true));
    if (phone) more.push({ key: "copy", label: "Copy number", icon: PhoneIcon, run: () => copy(phone, "Number copied.") });
    if (email) more.push({ key: "invite", label: "Invite", icon: CalendarIcon, run: () => void openInvite() });
    if (booking) more.push({ key: "booking", label: "Copy booking link", icon: CalendarIcon, run: () => copy(booking, "Booking link copied.") });
  } else {
    buttons.push(inviteButton, bookingButton, emailButton(false));
    if (phone) buttons.push(callButton(false, true));
    if (phone) more.push({ key: "copy", label: "Copy number", icon: PhoneIcon, run: () => copy(phone, "Number copied.") });
    if (thread) more.push({ key: "reply", label: "Reply on thread", icon: ReplyIcon, run: () => router.push(threadHref(thread.key, "reply")) });
    if (email) buttons.push(templateButton(true));
  }
  if (context && (askPhone || askEmail)) more.push({ key: "find", label: "Ask Orbit to find details", icon: SparkleIcon, run: ask });

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 [@media(pointer:coarse)]:gap-x-2.5 [@media(pointer:coarse)]:gap-y-3.5">
        {buttons}
        {more.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More actions" title="More actions" className={ICON_ACTION}>
                <MoreIcon aria-hidden className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {more.map((item) => (
                <DropdownMenuItem key={item.key} onSelect={item.run} className="[@media(pointer:coarse)]:min-h-11">
                  <item.icon aria-hidden className="text-subtle size-3.5" />
                  {item.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      {invite && (
        <InviteDialog
          open
          onOpenChange={(open) => {
            if (!open) setInvite(null);
          }}
          setup={invite.setup}
          prefill={prefill}
          now={invite.at}
          onSent={(message) => composer.showToast({ message })}
        />
      )}
    </>
  );
}

function ContactStrip({ task, context, kind, here }: Actions & { here?: TitleHere }) {
  const find = useFindAvailability();
  const onPage = here?.kind === "contact" && here.id === task.contactId;
  if (onPage) {
    return (
      <section aria-label="Actions" className="flex flex-col gap-2">
        <ContactActions task={task} context={context} kind={kind} />
      </section>
    );
  }
  const name = task.contactName ?? "Contact";
  const contactId = task.contactId ?? "";
  const findPhone = find.phone && Boolean(contactId) && !task.contactPhone;
  const findEmail = find.email && Boolean(contactId) && !task.contactEmail;
  const finding = findPhone || findEmail;
  return (
    <section aria-label={name} className={cn("flex flex-col gap-2.5 rounded-xl bg-white/[0.04] p-2.5 @2xl:flex-row @2xl:items-center", finding && "[@media(pointer:coarse)]:gap-y-6")}>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Monogram name={name} className="size-8 rounded-full text-[12px]" />
        <div className="@container/details flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            {task.contactId ? (
              <TaskRecordLink href={contactHref(task.contactId)} className="ui-style text-foreground truncate font-medium hover:underline">
                {name}
              </TaskRecordLink>
            ) : (
              <span className="ui-style font-medium">{name}</span>
            )}
            {(task.contactJobTitle || task.companyName) && (
              <span className="caption-style text-subtle min-w-0 truncate">
                {task.contactJobTitle}
                {task.contactJobTitle && task.companyName && ", "}
                {task.companyName &&
                  (task.companyId && here?.kind !== "company" ? (
                    <TaskRecordLink href={companyHref(task.companyId)} className="hover:text-foreground underline decoration-white/30 underline-offset-2">
                      {task.companyName}
                    </TaskRecordLink>
                  ) : (
                    task.companyName
                  ))}
              </span>
            )}
          </span>
          <div className={cn("caption-style text-soft flex min-w-0 flex-col items-start gap-y-0.5 tabular-nums @md/details:flex-row @md/details:items-center @md/details:gap-x-2", finding && "[@media(pointer:coarse)]:mt-3 [@media(pointer:coarse)]:gap-y-7")}>
            {task.contactPhone ? (
              <span>{task.contactPhone}</span>
            ) : (
              <span className="flex min-w-0 flex-wrap items-center gap-x-1">
                <span className="text-subtle">No number</span>
                {findPhone && <FindDetailButton contactId={contactId} field="phone" variant="text" lookup={context?.lookups.phone} className="hit" />}
              </span>
            )}
            <span aria-hidden className="text-faint hidden @md/details:inline">
              ·
            </span>
            {task.contactEmail ? (
              <span className="max-w-full min-w-0 truncate">{task.contactEmail}</span>
            ) : (
              <span className="flex min-w-0 flex-wrap items-center gap-x-1">
                <span className="text-subtle">No email</span>
                {findEmail && <FindDetailButton contactId={contactId} field="email" variant="text" lookup={context?.lookups.email} className="hit" />}
              </span>
            )}
          </div>
        </div>
      </div>
      <ContactActions task={task} context={context} kind={kind} />
    </section>
  );
}

function PersonRow({ person, busy, canLink, onLink }: { person: TaskPerson; busy: string | null; canLink: boolean; onLink: (person: TaskPerson) => void }) {
  return (
    <li className="flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-white/[0.04]">
      <Monogram name={person.name} className="size-6 rounded-full text-[10px]" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="ui-style text-foreground truncate">{person.name}</span>
        {(person.jobTitle || person.email) && <span className="caption-style text-subtle truncate">{person.jobTitle ?? person.email}</span>}
      </span>
      <span className={cn("caption-style shrink-0 tabular-nums max-sm:hidden", person.phone ? "text-soft" : "text-subtle")}>{person.phone ?? "No number"}</span>
      {canLink && (
        <Button
          variant="secondary"
          size="sm"
          disabled={Boolean(busy)}
          aria-busy={busy === person.id || undefined}
          aria-label={`Link ${person.name}`}
          onClick={() => onLink(person)}
          className="hit"
        >
          {busy === person.id ? "Linking…" : "Link"}
        </Button>
      )}
    </li>
  );
}

function CompanyStrip({ task, context, kind, canChange, here, onLinked }: Actions & { canChange: boolean; here?: TitleHere; onLinked: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const company = task.companyName ?? "Company";
  const people = context?.people ?? [];

  async function link(person: TaskPerson) {
    if (busy) return;
    setBusy(person.id);
    setError(null);
    const result = await relinkTaskAction(task.id, { contactId: person.id }).catch(() => ({ error: "Couldn't link the task. Try again." }));
    setBusy(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    onLinked();
    router.refresh();
  }

  return (
    <section aria-label={company} className="flex flex-col gap-1.5 rounded-xl bg-white/[0.04] p-2.5">
      <div className="flex flex-wrap items-center gap-2.5 px-0.5">
        <Monogram name={company} className="size-8 rounded-full text-[12px]" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {task.companyId && here?.kind !== "company" ? (
            <TaskRecordLink href={companyHref(task.companyId)} className="ui-style text-foreground truncate font-medium hover:underline">
              {company}
            </TaskRecordLink>
          ) : (
            <span className="ui-style font-medium">{company}</span>
          )}
          <span className="caption-style text-subtle">
            {canChange ? (kind === "call" ? "No person linked. Pick who to ring; it links the task." : "No person linked. Pick one; it links the task.") : "No person linked."}
          </span>
        </div>
        {callable(task.companyPhone) && <CallLink phone={task.companyPhone} label="Call switchboard" spoken={`Call ${company}'s switchboard`} primary={false} />}
      </div>
      {context && people.length === 0 && <p className="caption-style text-subtle border-line-subtle border-t px-0.5 pt-2">No people at {company} yet.</p>}
      {people.length > 0 && (
        <ul aria-label={`People at ${company}`} className="border-line-subtle flex flex-col border-t pt-1 [@media(pointer:coarse)]:gap-1.5">
          {people.map((person) => (
            <PersonRow key={person.id} person={person} busy={busy} canLink={canChange} onLink={(item) => void link(item)} />
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger px-0.5">
          {error}
        </p>
      )}
    </section>
  );
}

function Separator() {
  return (
    <span aria-hidden className="text-faint">
      ·
    </span>
  );
}

function ContextLine({ task, context, here }: { task: Task; context: TaskContext; here?: TitleHere }) {
  const opportunity = context.opportunity;
  const parts: ReactNode[] = [];
  if (opportunity) {
    const value = money(opportunity.value, opportunity.currency);
    const stage = opportunity.status === "won" ? "Won" : opportunity.status === "lost" ? "Lost" : (opportunity.stage ?? "Open");
    parts.push(
      <span key="opportunity" className="inline-flex min-w-0 items-center gap-1.5">
        <OpportunityIcon aria-hidden className="size-3 shrink-0" />
        {here?.kind === "opportunity" && here.id === opportunity.id ? (
          <span className="text-soft truncate">{opportunity.name}</span>
        ) : (
          <TaskRecordLink href={dealHref(opportunity.id)} className="text-soft hover:text-foreground truncate underline decoration-white/30 underline-offset-2">
            {opportunity.name}
          </TaskRecordLink>
        )}
        <Tag size="sm" tone={opportunity.status === "won" ? "green" : opportunity.status === "lost" ? "red" : "purple"} className="text-[12px]">
          {stage}
        </Tag>
        {value && <b className="text-foreground font-medium tabular-nums">{value}</b>}
      </span>,
    );
  } else if (task.contactId || task.companyId) {
    parts.push(<span key="opportunity">No open opportunity</span>);
  }
  if (context.lastActivity) {
    const label = TYPE_LABELS[context.lastActivity.type] ?? "Activity";
    const title = context.lastActivity.title?.trim();
    parts.push(
      <span key="activity" className="min-w-0">
        Last activity{" "}
        <b className="text-soft font-medium">
          {title ? (title.toLowerCase().startsWith(label.toLowerCase()) ? title : `${label}: ${title}`) : label}, {shortDate(context.lastActivity.occurredAt)}
        </b>
      </span>,
    );
  }
  if (context.thread) {
    parts.push(
      <span key="thread" className="min-w-0">
        Thread{" "}
        <b className="text-soft font-medium">
          &ldquo;{context.thread.subject?.trim() || "No subject"}&rdquo;{context.thread.at ? `, ${shortDate(context.thread.at)}` : ""}
        </b>
      </span>,
    );
  } else if (context.lastEmail) {
    parts.push(
      <span key="email" className="min-w-0">
        Last email{" "}
        <b className="text-soft font-medium">
          &ldquo;{context.lastEmail.subject?.trim() || "No subject"}&rdquo;, {shortDate(context.lastEmail.at)}
        </b>
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <p data-task-context="" className="caption-style text-subtle flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {parts.flatMap((part, index) => (index === 0 ? [part] : [<Separator key={`sep-${index}`} />, part]))}
    </p>
  );
}

export function TaskAct({ task, here, canChange }: { task: Task; here?: TitleHere; canChange: boolean }) {
  const { context, error, loading } = useTaskContext(task);
  const kind = taskKind(task.title);
  const box = useRef<HTMLDivElement>(null);
  const linkedHere = useRef(false);
  useEffect(() => {
    if (!task.contactId || !linkedHere.current) return;
    linkedHere.current = false;
    box.current?.querySelector<HTMLElement>("section a[href], section button")?.focus();
  }, [task.contactId]);
  if (!task.contactId && !task.companyId && !task.opportunityId) return null;
  return (
    <div ref={box} data-task-act="" className="flex flex-col gap-2.5">
      {task.contactId ? (
        <ContactStrip task={task} context={context} kind={kind} here={here} />
      ) : task.companyId ? (
        <CompanyStrip task={task} context={context} kind={kind} canChange={canChange && !task.completedAt} here={here} onLinked={() => (linkedHere.current = true)} />
      ) : null}
      {context && <ContextLine task={task} context={context} here={here} />}
      {loading && (
        <p role="status" className="caption-style text-subtle">
          <span className="sr-only">Loading the details</span>
          <span aria-hidden className="bg-surface-raised block h-3 w-2/3 animate-pulse rounded-full" />
        </p>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function EditLinks({ task }: { task: Task }) {
  const router = useRouter();
  const group = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function change(kind: "company" | "contact" | "opportunity", option: Parameters<typeof relinkChange>[2]) {
    if (busy) return;
    const next: LinkChange = relinkChange(task, kind, option);
    setBusy(true);
    setError(null);
    setNote(null);
    const result = await relinkTaskAction(task.id, next).catch(() => ({ error: "Couldn't link the task. Try again." }));
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setNote(relinkNote(task, kind, next));
    router.refresh();
  }

  function refocus(slot: string) {
    window.requestAnimationFrame(() => group.current?.querySelector<HTMLElement>(`[data-link-slot="${slot}"] button`)?.focus());
  }

  const record = (id: string | null, name: string | null) => (id && name ? { id, name } : null);
  return (
    <div ref={group} role="group" aria-label="Edit links" aria-busy={busy || undefined} className="flex flex-wrap items-center gap-1.5">
      <span data-link-slot="contact" className="inline-flex">
        <SearchChip
          kind="contact"
          icon={UserIcon}
          label="Person"
          value={record(task.contactId, task.contactName)}
          companyId={task.companyId}
          variant="card"
          taskId={task.id}
          onPick={(option) => void change("contact", option)}
          onClosed={() => refocus("contact")}
        />
      </span>
      <span data-link-slot="company" className="inline-flex">
        <SearchChip
          kind="company"
          icon={BuildingIcon}
          label="Company"
          value={record(task.companyId, task.companyName)}
          companyId={null}
          variant="card"
          taskId={task.id}
          onPick={(option) => void change("company", option)}
          onClosed={() => refocus("company")}
        />
      </span>
      <span data-link-slot="opportunity" className="inline-flex">
        <SearchChip
          kind="opportunity"
          icon={OpportunityIcon}
          label="Opportunity"
          value={record(task.opportunityId, task.opportunityName)}
          companyId={null}
          variant="card"
          taskId={task.id}
          onPick={(option) => void change("opportunity", option)}
          onClosed={() => refocus("opportunity")}
        />
      </span>
      {busy && (
        <span role="status" className="caption-style text-subtle">
          Saving…
        </span>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger basis-full">
          {error}
        </p>
      )}
      {note && !error && (
        <p role="status" className="caption-style text-subtle basis-full">
          {note}
        </p>
      )}
    </div>
  );
}
