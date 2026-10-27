import type { ReactNode } from "react";
import {
  BILLING_LABELS,
  BILLINGS,
  formatMoney,
  longDate,
  parseBody,
  safeHref,
  type Content,
  type Inline,
} from "@/lib/proposals/model";
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

function imageSrc(value: string) {
  const href = safeHref(value);
  return href && href.startsWith("https:") ? href : null;
}

export default function ProposalDocument({
  content,
  blocks = content.blocks,
  signatures = [],
  children,
  compact,
  withSignatures = true,
}: {
  content: Content;
  blocks?: Content["blocks"];
  signatures?: SignatureView[];
  children?: ReactNode;
  compact?: boolean;
  withSignatures?: boolean;
}) {
  const totals = BILLINGS.filter((billing) => content.totals[billing]);
  return (
    <article className={cn("flex flex-col", compact ? "gap-10" : "gap-14 sm:gap-16")}>
      {blocks.map((block, index) => {
        if (block.type === "tab") return null;
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
        return (
          <section key={block.id} id={sectionId(index)} aria-labelledby={`${sectionId(index)}-title`} className="flex scroll-mt-24 flex-col gap-5">
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
