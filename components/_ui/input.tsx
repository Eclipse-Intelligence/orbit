import type { ComponentProps } from "react";
import { inputClass } from "@/components/_ui/field-styles";
import { cn } from "@/lib/utils";

function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn(inputClass, className)} {...props} />;
}

export { Input };
