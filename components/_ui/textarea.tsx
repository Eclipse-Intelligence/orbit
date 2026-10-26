import type { ComponentProps } from "react";
import { textareaClass } from "@/components/_ui/field-styles";
import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(textareaClass, className)} {...props} />;
}

export { Textarea };
