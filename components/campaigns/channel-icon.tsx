import type { CampaignChannel } from "@/lib/campaigns/types";
import EmailIcon from "@/public/assets/images/campaigns/email.svg";
import LinkedinIcon from "@/public/assets/images/campaigns/linkedin.svg";

const ICONS = { email: EmailIcon, linkedin: LinkedinIcon } as const;

const LABELS: Record<CampaignChannel, string> = { email: "Email", linkedin: "LinkedIn" };

export default function ChannelIcon({ channel, className }: { channel: CampaignChannel; className?: string }) {
  const Icon = ICONS[channel];
  return (
    <>
      <Icon aria-hidden className={className} />
      <span className="sr-only">{LABELS[channel]}</span>
    </>
  );
}
