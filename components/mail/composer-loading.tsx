import { cn } from "@/lib/utils";

export function ComposerLoading({ fill = false }: { fill?: boolean }) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn("flex flex-col gap-3 px-4 py-3", fill ? "min-h-0 flex-1" : "bg-surface-field rounded-2xl")}
    >
      <span className="sr-only">Opening the editor</span>
      <span aria-hidden className="h-3 w-1/3 animate-pulse rounded-full bg-surface-raised" />
      <span aria-hidden className="h-3 w-1/2 animate-pulse rounded-full bg-surface-field" />
      <span aria-hidden className={cn("bg-surface-hover w-full animate-pulse rounded-xl", fill ? "min-h-24 flex-1" : "h-24")} />
    </div>
  );
}
