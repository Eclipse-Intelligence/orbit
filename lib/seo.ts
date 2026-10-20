import type { Metadata } from "next";
import { siteOrigin } from "@/lib/site-url";

export const SITE_NAME = "Orbit";
export const SITE_URL = siteOrigin() ?? "https://example.com";
export const SITE_DESCRIPTION =
  "A focused CRM for companies, relationships, and tasks.";
const DEFAULT_OG_IMAGE = "/logo.png";

export function absoluteUrl(path: string) {
  return new URL(path, SITE_URL).toString();
}

type SiteRoute = {
  path: string;
  title: string;
  description: string;
  changeFrequency?:
    | "always"
    | "hourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly"
    | "never";
  priority?: number;
};

export const SITE_ROUTES: SiteRoute[] = [
  {
    path: "/",
    title: "Companies",
    description: SITE_DESCRIPTION,
    changeFrequency: "weekly",
    priority: 1,
  },
];

type PageMetadataOptions = {
  title: string;
  description: string;
  path: string;
  image?: string;
};

export function pageMetadata({
  title,
  description,
  path,
  image = DEFAULT_OG_IMAGE,
}: PageMetadataOptions): Metadata {
  const url = absoluteUrl(path);

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      locale: "en",
      type: "website",
      url,
      siteName: SITE_NAME,
      title,
      description,
      images: [{ url: absoluteUrl(image) }],
    },
    twitter: {
      card: "summary",
      title,
      description,
      images: [absoluteUrl(image)],
    },
  };
}
