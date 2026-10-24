import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/mail",
    name: "Orbit",
    short_name: "Orbit",
    description: "Eclipse's CRM and mail.",
    start_url: "/mail",
    scope: "/",
    display: "standalone",
    background_color: "#161616",
    theme_color: "#161616",
    icons: [
      { src: "/apple-touch-icon-180x180.png", sizes: "180x180", type: "image/png", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
