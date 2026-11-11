import Link from "next/link";
import LinkedText from "@/components/_ui/linked-text";
import { recordHref } from "@/lib/docs/routes";
import { splitMentions } from "@/lib/mentions";
import { cn } from "@/lib/utils";

const MENTION = "rounded-[4px] bg-[var(--tag-purple-bg)] text-[var(--tag-purple-text)] shadow-[0_0_0_2px_var(--tag-purple-bg)]";
const MENTION_ME =
  "rounded-[4px] bg-[color-mix(in_srgb,var(--primary)_34%,transparent)] text-foreground shadow-[0_0_0_2px_color-mix(in_srgb,var(--primary)_34%,transparent)]";
const RECORD = "text-foreground underline decoration-[#8b7bff]/70 underline-offset-[3px] hover:decoration-[#8b7bff]";

export default function MessageBody({ body, viewerId, className }: { body: string; viewerId: string; className?: string }) {
  return (
    <div className={cn("text-foreground text-[14px] leading-[22px] whitespace-pre-wrap [overflow-wrap:anywhere]", className)}>
      {splitMentions(body).map((piece, index) => {
        if (!("mention" in piece)) return <LinkedText key={index} text={piece.text} />;
        const { mention } = piece;
        if (mention.kind === "member") {
          return (
            <span key={index} className={mention.id.toLowerCase() === viewerId.toLowerCase() ? MENTION_ME : MENTION}>
              @{mention.name}
            </span>
          );
        }
        return (
          <Link key={index} href={recordHref(mention.kind, mention.id)} className={RECORD}>
            {mention.name}
          </Link>
        );
      })}
    </div>
  );
}
