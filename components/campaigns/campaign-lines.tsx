import Link from "next/link";
import ChannelIcon from "@/components/campaigns/channel-icon";
import { campaignThreadPath } from "@/lib/campaigns/format";
import { contactLineText } from "@/lib/campaigns/thread-view";
import type { CampaignLine } from "@/lib/campaigns/threads";

export default function CampaignLines({ lines }: { lines: CampaignLine[] }) {
  if (lines.length === 0) return null;
  return (
    <ul aria-label="Campaigns" className="flex flex-col gap-1.5">
      {lines.map((line) => (
        <li key={line.prospectId} className="flex min-w-0">
          <Link
            href={campaignThreadPath(line.prospectId)}
            className="caption-style text-soft hover:text-foreground hit flex min-w-0 items-center gap-1.5 transition-colors duration-150"
          >
            <ChannelIcon channel={line.channel} className="size-3 shrink-0" />
            <span className="truncate" suppressHydrationWarning>
              {contactLineText(line)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
