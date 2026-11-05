import { cn } from "@/lib/utils";
import { workspaceInitial, workspaceTone, type TileTone } from "@/lib/workspace-paths";

const TONE_CLASSES: Record<TileTone, string> = {
  orange: "bg-(--tag-orange-bg) text-(--tag-orange-text) shadow-[inset_0_0_0_1px_var(--tag-orange-border)]",
  purple: "bg-(--tag-purple-bg) text-(--tag-purple-text) shadow-[inset_0_0_0_1px_var(--tag-purple-border)]",
  blue: "bg-(--tag-blue-bg) text-(--tag-blue-text) shadow-[inset_0_0_0_1px_var(--tag-blue-border)]",
  green: "bg-(--tag-green-bg) text-(--tag-green-text) shadow-[inset_0_0_0_1px_var(--tag-green-border)]",
  teal: "bg-(--tag-teal-bg) text-(--tag-teal-text) shadow-[inset_0_0_0_1px_var(--tag-teal-border)]",
  amber: "bg-(--tag-amber-bg) text-(--tag-amber-text) shadow-[inset_0_0_0_1px_var(--tag-amber-border)]",
  red: "bg-(--tag-red-bg) text-(--tag-red-text) shadow-[inset_0_0_0_1px_var(--tag-red-border)]",
  yellow: "bg-(--tag-yellow-bg) text-(--tag-yellow-text) shadow-[inset_0_0_0_1px_var(--tag-yellow-border)]",
};

export default function WorkspaceTile({ id, name, className }: { id: string; name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[10px] leading-none font-semibold",
        TONE_CLASSES[workspaceTone(id)],
        className,
      )}
    >
      {workspaceInitial(name)}
    </span>
  );
}
