import Button from "@/components/_ui/button";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "campaigns", label: "Campaigns", href: "/campaigns" },
  { id: "conversations", label: "Conversations", href: "/campaigns/conversations" },
] as const;

export type CampaignsTab = (typeof TABS)[number]["id"];

export default function CampaignsHeading({ current }: { current: CampaignsTab }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <h1 className="shrink-0 max-sm:sr-only">Campaigns</h1>
      <nav aria-label="Campaigns" className="flex min-w-0 items-center gap-0.5">
        {TABS.map((tab) => (
          <Button
            key={tab.id}
            variant="ghost"
            size="none"
            href={tab.href}
            aria-current={current === tab.id ? "page" : undefined}
            className={cn("hit h-8 shrink-0 px-2.5 text-[13px] font-medium", current === tab.id ? "text-foreground bg-white/[0.07] hover:bg-white/[0.07]" : "text-subtle")}
          >
            {tab.label}
          </Button>
        ))}
      </nav>
    </span>
  );
}
