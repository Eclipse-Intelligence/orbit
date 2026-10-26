import type { ComponentProps } from "react";
import { selectClass } from "@/components/_ui/field-styles";
import { cn } from "@/lib/utils";

function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return <select data-slot="native-select" className={cn(selectClass, className)} {...props} />;
}

export { NativeSelect };
