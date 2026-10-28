import type { ReactNode } from "react";
import {
  BILLING_LABELS,
  BILLINGS,
  embedSource,
  embedTakesForms,
  formatMoney,
  longDate,
  parseBody,
  httpsImage,
  safeHref,
  shows,
  videoSource,
  type Block,
  type Content,
  type Inline,
  type Step,
} from "@/lib/proposals/model";
import { BookingPanel } from "@/components/booking/booking-screen";
import type { PublicBookingPage } from "@/lib/booking/pages";
import CheckIcon from "@/public/assets/images/booking/check.svg";
import ExternalIcon from "@/public/assets/images/booking/external.svg";
import FileIcon from "@/public/assets/images/settings/file-text.svg";
import LinkIcon from "@/public/assets/images/settings/link.svg";
import Asset from "@/components/_ui/asset";
import { cn } from "@/lib/utils";
import { signatureFont } from "@/components/proposals/signature-font";
import Image from "next/image";

type SignatureView = { role: "client" | "sender"; name: string; title: string | null; signatureText: string; signatureImage?: string | null; signedAt: string };

function Parts({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((part, index) => {
        if (part.href) {
          const href = safeHref(part.href);
          return href ? (
            <a key={index} href={href} target="_blank" rel="noreferrer" className="underline decoration-1 underline-offset-[3px]">
              {part.text}
            </a>
          ) : (
            <span key={index}>{part.text}</span>
          );
        }
        return part.bold ? (
          <strong key={index} className="font-semibold">
            {part.text}
          </strong>
        ) : (
          <span key={index} className="whitespace-pre-line">
            {part.text}
          </span>
        );
      })}
    </>
  );
}

function Body({ value }: { value: string }) {
  const paragraphs = parseBody(value);
  const out: ReactNode[] = [];
  let bullets: ReactNode[] = [];
  const flush = (key: string) => {
    if (bullets.length) out.push(<ul key={key} className="doc-body text-soft flex list-disc flex-col gap-1.5 pl-5">{bullets}</ul>);
    bullets = [];
  };
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.kind === "bullet") {
      bullets.push(
        <li key={index}>
          <Parts parts={paragraph.parts} />
        </li>,
      );
      return;
    }
    flush(`list-${index}`);
    out.push(
      paragraph.kind === "subheading" ? (
        <h4 key={index} className="text-foreground text-[16px] leading-6 font-semibold">
          <Parts parts={paragraph.parts} />
        </h4>
      ) : (
        <p key={index} className="doc-body text-soft">
          <Parts parts={paragraph.parts} />
        </p>
      ),
    );
  });
  flush("list-end");
  return <div className="flex flex-col gap-4">{out}</div>;
}

export function ProposalLogo({ src, company, className }: { src: string; company: string; className?: string }) {
  return (
    <Asset
      type="image"
      src={src}
      alt={company}
      width={4}
      height={1}
      fit="contain"
      mediaClassName="object-left"
      unoptimized
      className={cn("h-10 w-40", className)}
    />
  );
}

function sectionId(index: number) {
  return `section-${index + 1}`;
}

export function Signatures({ content, signatures, children }: { content: Content; signatures: SignatureView[]; children?: ReactNode }) {
  return (
    <section id="sign" aria-labelledby="sign-title" className="flex scroll-mt-32 flex-col gap-5">
      <h2 id="sign-title" className="doc-heading">
        Signatures
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {(["client", "sender"] as const).map((role) => {
          const party = role === "client" ? content.client : content.sender;
          const signed = signatures.find((item) => item.role === role);
          return (
            <div key={role} className="bg-card flex flex-col gap-2 rounded-2xl p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.05)]">
              <span className="text-subtle text-[12.5px] font-medium tracking-[0.04em] uppercase">For {party.company}</span>
              {signed ? (
                signed.signatureImage ? (
                  <Image src={signed.signatureImage} alt={`Signature of ${signed.name}`} width={240} height={54} unoptimized className="h-[54px] w-auto self-start object-contain" />
                ) : (
                  <span className={cn(signatureFont.className, "text-[34px] leading-[42px]")}>{signed.signatureText}</span>
                )
              ) : (
                <span className="text-subtle text-[15px] leading-[42px]">Waiting for signature</span>
              )}
              <span className="border-border border-t pt-2 text-[14px]">
                {signed?.name ?? party.name}
                {(signed?.title ?? party.title) && <span className="text-subtle">, {signed?.title ?? party.title}</span>}
              </span>
              {signed && <span className="text-subtle text-[13px]">Signed {longDate(signed.signedAt)}</span>}
            </div>
          );
        })}
      </div>
      {children}
    </section>
  );
}

const KIND_LABEL: Record<string, string> = {
  file: "Document",
  link: "Web page",
  youtube: "Video",
  podcast: "Podcast",
  transcript: "Transcript",
  attachment: "Document",
  reader: "Article",
};

export type SiteExtras = {
  fileHref?: (itemId: string) => string | null;
  booking?: PublicBookingPage | null;
  bookingDefaults?: { name?: string; email?: string };
  preview?: boolean;
  steps?: Step[];
  onToggleStep?: (stepId: string, done: boolean) => void;
  pendingStep?: string | null;
};

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value));
}

function Steps({ block, content, extras }: { block: Extract<Block, { type: "steps" }>; content: Content; extras: SiteExtras }) {
  const steps: Step[] =
    extras.steps ??
    block.items
      .filter((item) => item.title.trim())
      .map((item, index) => ({ id: `sample-${index}`, title: item.title, side: item.side, dueDate: null, doneAt: null, doneBy: null, doneName: null }));
  if (steps.length === 0) return extras.preview ? <Placeholder>Add steps for both sides.</Placeholder> : null;
  const done = steps.filter((step) => step.doneAt).length;
  return (
    <div className="flex flex-col gap-4">
      {block.intro && <Body value={block.intro} />}
      <div className="flex items-center gap-3">
        <div className="bg-secondary h-1.5 flex-1 overflow-hidden rounded-full">
          <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.round((done / steps.length) * 100)}%`, backgroundColor: content.accent }} />
        </div>
        <span className="text-subtle shrink-0 text-[13.5px] tabular-nums">
          {done} of {steps.length} done
        </span>
      </div>
      <ol className="bg-card divide-border flex flex-col divide-y overflow-hidden rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
        {steps.map((step) => {
          const owner = step.side === "client" ? content.client.company : content.sender.company;
          const tickable = step.side === "client" && Boolean(extras.onToggleStep);
          const meta = [
            owner,
            step.doneAt ? `Done${step.doneName ? ` by ${step.doneName}` : ""}, ${shortDate(step.doneAt)}` : step.dueDate ? `By ${shortDate(step.dueDate)}` : null,
          ].filter(Boolean);
          const mark = (
            <span
              aria-hidden
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-white transition-colors duration-150",
                !step.doneAt && "shadow-[inset_0_0_0_1.5px_var(--input)]",
              )}
              style={step.doneAt ? { backgroundColor: content.accent } : undefined}
            >
              {step.doneAt && <CheckIcon className="size-3.5" />}
            </span>
          );
          return (
            <li key={step.id} className="flex items-start gap-3 px-5 py-4">
              {tickable ? (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={Boolean(step.doneAt)}
                  aria-label={step.title}
                  disabled={extras.pendingStep === step.id}
                  onClick={() => extras.onToggleStep?.(step.id, !step.doneAt)}
                  className="-m-1 cursor-pointer rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-60"
                >
                  {mark}
                </button>
              ) : (
                mark
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cn("text-[15.5px] leading-6", step.doneAt && "text-subtle line-through decoration-1")}>{step.title}</span>
                <span className="text-subtle text-[13.5px]">{meta.join(" · ")}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function initialsOf(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

function Frame({ src, title, ratio = "aspect-video" }: { src: string; title: string; ratio?: string }) {
  return (
    <div className={cn("bg-secondary overflow-hidden rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.06)]", ratio)}>
      <iframe
        src={src}
        title={title}
        loading="lazy"
        allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox={cn("allow-scripts allow-same-origin allow-popups allow-presentation", embedTakesForms(src) && "allow-forms")}
        className="size-full border-0"
      />
    </div>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return <p className="bg-secondary text-subtle rounded-2xl px-5 py-8 text-center text-[14px]">{children}</p>;
}

function Extra({ block, content, extras }: { block: Block; content: Content; extras: SiteExtras }) {
  if (block.type === "steps") return <Steps block={block} content={content} extras={extras} />;
  if (block.type === "video") {
    const video = videoSource(block.url);
    return (
      <>
        {video?.kind === "frame" && <Frame src={video.src} title={block.heading || "Video"} />}
        {video?.kind === "file" && <video src={video.src} controls playsInline preload="metadata" className="w-full rounded-2xl bg-black" />}
        {!video && extras.preview && <Placeholder>Add a YouTube, Loom or Vimeo link.</Placeholder>}
        {block.caption && <p className="text-subtle text-[14px] leading-6">{block.caption}</p>}
      </>
    );
  }
  if (block.type === "image") {
    const src = imageSrc(block.url);
    return (
      <>
        {src ? (
          <Asset type="image" src={src} alt={block.caption || ""} width={16} height={9} fit="contain" unoptimized className="bg-secondary rounded-2xl" />
        ) : (
          extras.preview && <Placeholder>Upload an image.</Placeholder>
        )}
        {block.caption && <p className="text-subtle text-[14px] leading-6">{block.caption}</p>}
      </>
    );
  }
  if (block.type === "embed") {
    const src = embedSource(block.url);
    return (
      <>
        {src ? <Frame src={src} title={block.heading || "Embedded content"} ratio="aspect-[16/10]" /> : extras.preview && <Placeholder>{block.url.trim() ? "This site can't be embedded." : "Add a link to embed."}</Placeholder>}
        {(block.caption || src) && (
          <p className="text-subtle flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] leading-6">
            {block.caption && <span>{block.caption}</span>}
            {src && safeHref(block.url) && (
              <a href={safeHref(block.url)!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline decoration-1 underline-offset-[3px]">
                Open in a new tab
                <ExternalIcon aria-hidden className="size-3.5" />
              </a>
            )}
          </p>
        )}
      </>
    );
  }
  if (block.type === "documents") {
    return (
      <>
        {block.intro && <Body value={block.intro} />}
        {block.items.length === 0 ? (
          extras.preview && <Placeholder>Choose documents from Knowledge.</Placeholder>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {block.items.map((item) => {
              const href = extras.fileHref?.(item.id) ?? (safeHref(item.sourceUrl) || null);
              const Icon = item.kind === "link" || item.kind === "youtube" || item.kind === "podcast" ? LinkIcon : FileIcon;
              const inner = (
                <>
                  <span className="bg-secondary text-soft flex size-10 shrink-0 items-center justify-center rounded-xl">
                    <Icon aria-hidden className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[15px] leading-6 font-medium">{item.title}</span>
                    <span className="text-subtle text-[13px]">{KIND_LABEL[item.kind] ?? "Document"}</span>
                  </span>
                  {href && <ExternalIcon aria-hidden className="text-subtle size-4 shrink-0" />}
                </>
              );
              return (
                <li key={item.id}>
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="bg-card flex items-center gap-3 rounded-2xl p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06)] transition-shadow duration-150 outline-none hover:shadow-[0_0_0_1px_rgba(0,0,0,0.14)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    >
                      {inner}
                    </a>
                  ) : (
                    <div className="bg-card flex items-center gap-3 rounded-2xl p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  }
  if (block.type === "booking") {
    return (
      <>
        {block.intro && <Body value={block.intro} />}
        {extras.booking ? (
          <div className="night overflow-hidden rounded-3xl bg-[#0b0b10] shadow-[0_24px_60px_-20px_rgba(0,0,0,0.45)]">
            <BookingPanel page={extras.booking} defaults={extras.bookingDefaults} embedded className="sm:px-7" />
          </div>
        ) : (
          extras.preview && <Placeholder>Your booking calendar shows here for clients. Switch your booking page on in Settings.</Placeholder>
        )}
      </>
    );
  }
  if (block.type === "faq") {
    return (
      <div className="flex flex-col gap-3">
        {block.items
          .filter((item) => item.question.trim())
          .map((item, index) => (
            <details key={index} className="group bg-card rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.06)] open:shadow-[0_0_0_1px_rgba(0,0,0,0.12)]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-4 text-[16px] leading-6 font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] [&::-webkit-details-marker]:hidden">
                {item.question}
                <span aria-hidden className="text-subtle text-[20px] leading-none transition-transform duration-150 group-open:rotate-45">
                  +
                </span>
              </summary>
              <div className="px-5 pb-5">
                <Body value={item.answer} />
              </div>
            </details>
          ))}
      </div>
    );
  }
  if (block.type === "quote") {
    if (!block.quote.trim()) return extras.preview ? <Placeholder>Add a quote.</Placeholder> : null;
    return (
      <figure className="flex flex-col gap-4 border-l-[3px] pl-5" style={{ borderColor: content.accent }}>
        <blockquote className="text-[22px] leading-[1.45] font-medium tracking-[-0.01em] text-balance">&ldquo;{block.quote.trim()}&rdquo;</blockquote>
        {(block.name || block.role) && (
          <figcaption className="text-subtle text-[14.5px]">
            <span className="text-foreground font-medium">{block.name}</span>
            {block.name && block.role ? ", " : ""}
            {block.role}
          </figcaption>
        )}
      </figure>
    );
  }
  if (block.type === "team") {
    const people = block.people.filter((person) => person.name.trim());
    return (
      <ul className="grid gap-3 sm:grid-cols-2">
        {people.map((person, index) => {
          const photo = imageSrc(person.photo);
          const email = person.email.trim();
          return (
            <li key={index} className="bg-card flex items-center gap-4 rounded-2xl p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
              {photo ? (
                <Asset type="image" src={photo} alt="" width={1} height={1} fit="cover" unoptimized className="size-14 shrink-0 rounded-full" />
              ) : (
                <span aria-hidden className="flex size-14 shrink-0 items-center justify-center rounded-full text-[17px] font-semibold text-white" style={{ backgroundColor: content.accent }}>
                  {initialsOf(person.name)}
                </span>
              )}
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[15.5px] leading-6 font-semibold">{person.name}</span>
                {person.role && <span className="text-subtle truncate text-[14px]">{person.role}</span>}
                {email && /^[^\s@]+@[^\s@]+$/.test(email) && (
                  <a href={`mailto:${email}`} className="truncate text-[14px] underline decoration-1 underline-offset-[3px]" style={{ color: content.accent }}>
                    {email}
                  </a>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }
  return null;
}

function imageSrc(value: string) {
  return httpsImage(value);
}

export default function ProposalDocument({
  content,
  blocks = content.blocks,
  signatures = [],
  children,
  compact,
  withSignatures = true,
  extras = {},
}: {
  content: Content;
  blocks?: Content["blocks"];
  signatures?: SignatureView[];
  children?: ReactNode;
  compact?: boolean;
  withSignatures?: boolean;
  extras?: SiteExtras;
}) {
  const totals = BILLINGS.filter((billing) => content.totals[billing]);
  return (
    <article className={cn("flex flex-col", compact ? "gap-10" : "gap-14 sm:gap-16")}>
      {blocks.map((block, index) => {
        if (block.type === "tab") return null;
        if (!extras.preview && !shows(block, { booking: Boolean(extras.booking), steps: extras.steps ? extras.steps.length > 0 : undefined })) return null;
        if (block.type === "pricing" && content.items.length === 0 && !extras.preview) return null;
        if (block.type === "cover") {
          const cover = imageSrc(block.image);
          return (
            <header key={block.id} id={sectionId(index)} className="flex scroll-mt-24 flex-col gap-5">
              {cover && <Asset type="image" src={cover} alt="" width={12} height={5} fit="cover" unoptimized className="mb-2 rounded-2xl shadow-[0_0_0_1px_rgba(0,0,0,0.05)]" />}
              {content.logo ? (
                <ProposalLogo src={content.logo} company={content.sender.company} className="mb-2" />
              ) : (
                <span aria-hidden className="block h-1.5 w-14 rounded-full" style={{ backgroundColor: content.accent }} />
              )}
              <h1 className="doc-title">{block.title || content.title}</h1>
              {block.subtitle && <p className="doc-lead text-soft max-w-[34em]">{block.subtitle}</p>}
              <dl className="text-subtle flex flex-wrap gap-x-6 gap-y-1 text-[13.5px]">
                <div className="flex gap-1.5">
                  <dt>Issued</dt>
                  <dd className="text-foreground">{longDate(content.issuedAt)}</dd>
                </div>
                {content.validUntil && (
                  <div className="flex gap-1.5">
                    <dt>Valid until</dt>
                    <dd className="text-foreground">{longDate(content.validUntil)}</dd>
                  </div>
                )}
                <div className="flex gap-1.5">
                  <dt>From</dt>
                  <dd className="text-foreground">
                    {content.sender.name}, {content.sender.company}
                  </dd>
                </div>
              </dl>
            </header>
          );
        }
        const titled = "heading" in block && Boolean(block.heading);
        return (
          <section key={block.id} id={sectionId(index)} aria-labelledby={titled ? `${sectionId(index)}-title` : undefined} className="flex scroll-mt-24 flex-col gap-5">
            {"heading" in block && block.heading && (
              <h2 id={`${sectionId(index)}-title`} className="doc-heading">
                {block.heading}
              </h2>
            )}
            {block.type === "section" && <Body value={block.body} />}
            {block.type === "terms" && (
              <>
                <Body value={block.body} />
                {safeHref(block.linkUrl) && (
                  <a
                    href={safeHref(block.linkUrl)!}
                    target="_blank"
                    rel="noreferrer"
                    className="doc-body self-start font-medium underline decoration-1 underline-offset-[3px]"
                    style={{ color: content.accent }}
                  >
                    {block.linkLabel || "Read the terms and conditions"}
                  </a>
                )}
              </>
            )}
            <Extra block={block} content={content} extras={extras} />
            {block.type === "pricing" && (
              <>
                {block.intro && <Body value={block.intro} />}
                <div className="bg-card overflow-hidden rounded-2xl shadow-[0_1px_0_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.05)]">
                  <ul className="divide-border flex flex-col divide-y">
                    {content.items.map((item, itemIndex) => (
                      <li key={itemIndex} className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-start sm:gap-6">
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="text-[16px] leading-6 font-semibold">
                            {item.name}
                            {item.quantity > 1 && <span className="text-subtle font-normal"> × {item.quantity}</span>}
                          </span>
                          {item.description && <span className="text-subtle text-[14px] leading-6">{item.description}</span>}
                        </div>
                        <div className="flex shrink-0 items-baseline gap-2 sm:flex-col sm:items-end sm:gap-0.5">
                          <span className="text-[16px] leading-6 font-semibold tabular-nums">{formatMoney(item.unitPrice * item.quantity, content.currency)}</span>
                          <span className="text-subtle text-[13px]">{BILLING_LABELS[item.billing]}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {totals.length > 0 && (
                    <dl className="bg-secondary/60 flex flex-col gap-1.5 px-5 py-4">
                      {totals.map((billing) => (
                        <div key={billing} className="flex items-baseline justify-between gap-4">
                          <dt className="text-soft text-[14px]">{billing === "one_off" ? "Total one-off" : billing === "monthly" ? "Total a month" : "Total a year"}</dt>
                          <dd className="text-[18px] font-semibold tabular-nums">{formatMoney(content.totals[billing], content.currency)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              </>
            )}
          </section>
        );
      })}
      {withSignatures && (
        <Signatures content={content} signatures={signatures}>
          {children}
        </Signatures>
      )}
    </article>
  );
}
