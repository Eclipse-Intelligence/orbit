import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { APPLE_TOUCH_ICON_DATA_URI } from "@/lib/apple-touch-icon";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL, pageMetadata } from "@/lib/seo";
import ScrollToTop from "@/components/_common/scroll-to-top";
import StaleDeployReload from "@/components/_common/stale-deploy-reload";
import { SIDEBAR_COLLAPSED_SCRIPT, SIDEBAR_WIDTH_SCRIPT } from "@/lib/sidebar";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  ...pageMetadata({
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    path: "/",
  }),
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "Orbit", statusBarStyle: "black" },
};

export const viewport: Viewport = {
  themeColor: "#161616",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={geist.variable}
      suppressHydrationWarning
    >
      <head>
        <link rel="icon" href="/icons/icon-192.png" sizes="192x192" type="image/png" />
        <link rel="apple-touch-icon" href={APPLE_TOUCH_ICON_DATA_URI} sizes="180x180" />
        <script
          dangerouslySetInnerHTML={{
            __html: `history.scrollRestoration="manual";${SIDEBAR_WIDTH_SCRIPT}${SIDEBAR_COLLAPSED_SCRIPT}`,
          }}
        />
      </head>
      <body className="relative z-0 font-sans antialiased">
        <ScrollToTop />
        <StaleDeployReload />
        {children}
      </body>
    </html>
  );
}
