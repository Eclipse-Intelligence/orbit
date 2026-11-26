import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Not found",
  description: null,
  robots: { index: false, follow: false, nocache: true },
  alternates: null,
  openGraph: null,
  twitter: null,
  appleWebApp: null,
  manifest: null,
  applicationName: null,
};

export default function PublicDocsLayout({ children }: { children: ReactNode }) {
  return children;
}
