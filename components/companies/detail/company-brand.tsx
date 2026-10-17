import type { BrandLink, CompanyBrand } from "@/lib/crm/types";
import FacebookIcon from "@/public/assets/images/companies/socials/facebook.svg";
import GithubIcon from "@/public/assets/images/companies/socials/github.svg";
import InstagramIcon from "@/public/assets/images/companies/socials/instagram.svg";
import LinkIcon from "@/public/assets/images/companies/socials/link.svg";
import LinkedinIcon from "@/public/assets/images/companies/socials/linkedin.svg";
import TiktokIcon from "@/public/assets/images/companies/socials/tiktok.svg";
import XIcon from "@/public/assets/images/companies/socials/x.svg";
import YoutubeIcon from "@/public/assets/images/companies/socials/youtube.svg";

const SOCIAL_ICONS: Record<string, typeof LinkIcon> = {
  linkedin: LinkedinIcon,
  x: XIcon,
  facebook: FacebookIcon,
  instagram: InstagramIcon,
  youtube: YoutubeIcon,
  github: GithubIcon,
  tiktok: TiktokIcon,
};

const SOCIAL_NAMES: Record<string, string> = {
  linkedin: "LinkedIn",
  x: "X",
  facebook: "Facebook",
  instagram: "Instagram",
  youtube: "YouTube",
  github: "GitHub",
  tiktok: "TikTok",
  pinterest: "Pinterest",
  dribbble: "Dribbble",
  behance: "Behance",
  medium: "Medium",
  crunchbase: "Crunchbase",
  producthunt: "Product Hunt",
  reddit: "Reddit",
  discord: "Discord",
  twitch: "Twitch",
  vimeo: "Vimeo",
  spotify: "Spotify",
  soundcloud: "SoundCloud",
  tripadvisor: "Tripadvisor",
  yelp: "Yelp",
  appstore: "App Store",
  playstore: "Google Play",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  threads: "Threads",
  bluesky: "Bluesky",
};

const SOCIAL_ORDER = ["linkedin", "x", "instagram", "facebook", "youtube", "tiktok", "github", "crunchbase"];

const LINK_LABELS: Record<BrandLink, string> = {
  careers: "Careers",
  pricing: "Pricing",
  blog: "Blog",
  contact: "Contact",
  terms: "Terms",
  privacy: "Privacy",
};

function socialName(type: string) {
  return SOCIAL_NAMES[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

export function SocialLinks({ socials, fallbackLinkedin }: { socials: CompanyBrand["socials"]; fallbackLinkedin: string | null }) {
  const list = [...socials];
  if (fallbackLinkedin && !list.some((social) => social.type === "linkedin")) list.unshift({ type: "linkedin", url: fallbackLinkedin });
  const rank = (type: string) => (SOCIAL_ORDER.includes(type) ? SOCIAL_ORDER.indexOf(type) : SOCIAL_ORDER.length);
  list.sort((left, right) => rank(left.type) - rank(right.type));
  if (list.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-1">
      {list.map((social) => {
        const Icon = SOCIAL_ICONS[social.type] ?? LinkIcon;
        const name = socialName(social.type);
        return (
          <li key={social.type}>
            <a
              href={social.url}
              target="_blank"
              rel="noreferrer"
              title={name}
              aria-label={name}
              className="text-soft hover:text-foreground focus-visible:ring-ring/60 flex size-7 items-center justify-center rounded-full bg-white/[0.05] transition-colors duration-150 ease-power3-out outline-none hover:bg-white/[0.1] focus-visible:ring-2"
            >
              <Icon aria-hidden className="size-3.5" />
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function QuickLinks({ links }: { links: CompanyBrand["links"] }) {
  const entries = (Object.keys(LINK_LABELS) as BrandLink[]).filter((key) => links[key] && key !== "terms" && key !== "privacy");
  if (entries.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {entries.map((key) => (
        <a key={key} href={links[key]} target="_blank" rel="noreferrer" className="hover:underline">
          {LINK_LABELS[key]}
        </a>
      ))}
    </span>
  );
}

export function sectorLabel(industries: CompanyBrand["industries"]) {
  return industries.map((entry) => (entry.subindustry ? `${entry.industry} › ${entry.subindustry}` : entry.industry)).join(", ");
}

export function employeesLabel(employees: CompanyBrand["employees"]) {
  if (!employees) return null;
  if (employees.exact) return `About ${employees.exact.toLocaleString("en-GB")}`;
  return employees.range;
}
