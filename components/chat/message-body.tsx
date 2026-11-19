import Link from "next/link";
import type { ReactNode } from "react";
import LinkedText from "@/components/_ui/linked-text";
import { recordHref } from "@/lib/docs/routes";
import { parseMarkdown, type Block, type ChatFormat, type Inline } from "@/lib/chat/markdown";
import { plainMentions, splitMentions, type Mention } from "@/lib/mentions";
import { cn } from "@/lib/utils";

const MENTION = "rounded-[4px] bg-[var(--tag-purple-bg)] text-[var(--tag-purple-text)] shadow-[0_0_0_2px_var(--tag-purple-bg)]";
const MENTION_ME =
  "rounded-[4px] bg-[color-mix(in_srgb,var(--primary)_34%,transparent)] text-foreground shadow-[0_0_0_2px_color-mix(in_srgb,var(--primary)_34%,transparent)]";
const RECORD = "text-foreground underline decoration-violet/70 underline-offset-[3px] hover:decoration-violet";
const LINK = "text-soft underline decoration-white/35 underline-offset-[3px] [overflow-wrap:anywhere] hover:text-foreground hover:decoration-current";
const BODY = "text-foreground text-[14px] leading-[22px] whitespace-pre-wrap [overflow-wrap:anywhere]";

type Viewer = { viewerId: string; names?: Map<string, string> };

function MentionChip({ mention, viewer }: { mention: Mention; viewer: Viewer }) {
  if (mention.kind === "member") {
    return (
      <span className={mention.id.toLowerCase() === viewer.viewerId.toLowerCase() ? MENTION_ME : MENTION}>
        @{viewer.names?.get(mention.id.toLowerCase()) ?? mention.name}
      </span>
    );
  }
  return (
    <Link href={recordHref(mention.kind, mention.id)} className={RECORD}>
      {mention.name}
    </Link>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const mail = href.toLowerCase().startsWith("mailto:");
  return (
    <a href={href} target={mail ? undefined : "_blank"} rel={mail ? undefined : "noopener noreferrer"} className={LINK}>
      {children}
    </a>
  );
}

function renderInline(nodes: Inline[], viewer: Viewer): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return <LinkedText key={index} text={node.text} />;
      case "mention":
        return <MentionChip key={index} mention={node.mention} viewer={viewer} />;
      case "code":
        return (
          <code key={index} className="bg-surface-raised rounded-[4px] px-1 py-px font-mono text-[12.5px]">
            {plainMentions(node.text)}
          </code>
        );
      case "url":
        return (
          <ExternalLink key={index} href={node.href}>
            {node.text}
          </ExternalLink>
        );
      case "link":
        return (
          <ExternalLink key={index} href={node.href}>
            {renderInline(node.children, viewer)}
          </ExternalLink>
        );
      case "bold":
        return (
          <strong key={index} className="font-semibold">
            {renderInline(node.children, viewer)}
          </strong>
        );
      case "italic":
        return <em key={index}>{renderInline(node.children, viewer)}</em>;
      case "strike":
        return <s key={index}>{renderInline(node.children, viewer)}</s>;
    }
  });
}

function renderBlock(block: Block, index: number, viewer: Viewer) {
  switch (block.type) {
    case "paragraph":
      return <div key={index}>{renderInline(block.children, viewer)}</div>;
    case "code":
      return (
        <pre key={index} className="bg-surface-raised border-line-subtle rounded-lg border px-3 py-2 font-mono text-[12.5px] leading-5 whitespace-pre-wrap">
          {plainMentions(block.text)}
        </pre>
      );
    case "quote":
      return (
        <blockquote key={index} className="border-line-strong text-soft border-l-2 pl-3">
          {renderInline(block.children, viewer)}
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, viewer)}</li>);
      return block.ordered ? (
        <ol key={index} start={block.start} className="list-decimal pl-6 whitespace-normal">
          {items}
        </ol>
      ) : (
        <ul key={index} className="list-disc pl-5 whitespace-normal">
          {items}
        </ul>
      );
    }
  }
}

export default function MessageBody({
  body,
  format = "plain",
  viewerId,
  names,
  className,
}: {
  body: string;
  format?: ChatFormat;
  viewerId: string;
  names?: Map<string, string>;
  className?: string;
}) {
  const viewer = { viewerId, names };
  if (format === "markdown") {
    return <div className={cn(BODY, "flex flex-col gap-1", className)}>{parseMarkdown(body).map((block, index) => renderBlock(block, index, viewer))}</div>;
  }
  return (
    <div className={cn(BODY, className)}>
      {splitMentions(body).map((piece, index) => ("mention" in piece ? <MentionChip key={index} mention={piece.mention} viewer={viewer} /> : <LinkedText key={index} text={piece.text} />))}
    </div>
  );
}
