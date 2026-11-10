import { Fragment } from "react";
import { textParts } from "@/lib/text-links";

const LINK = "text-soft underline decoration-white/35 underline-offset-[3px] [overflow-wrap:anywhere] hover:text-foreground hover:decoration-current";

export default function LinkedText({ text }: { text: string }) {
  return textParts(text, { emails: true }).map((part, index) => {
    if (part.kind === "text") return <Fragment key={index}>{part.text}</Fragment>;
    if (part.kind === "email") {
      return (
        <a key={index} href={part.href} className={LINK}>
          {part.text}
        </a>
      );
    }
    return (
      <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" className={LINK}>
        {part.text}
      </a>
    );
  });
}
