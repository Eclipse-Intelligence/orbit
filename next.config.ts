import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  outputFileTracingIncludes: {
    "/**": ["./lib/proposals/fonts/*.ttf"],
  },
  async redirects() {
    return [
      { source: "/inbox", destination: "/capture", permanent: true },
      { source: "/companies", destination: "/", permanent: false },
    ];
  },
  images: {
    formats: ["image/avif", "image/webp"],
    qualities: [75, 90],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "api.builder.io",
      },
      {
        protocol: "https",
        hostname: "**.context.dev",
      },
      {
        protocol: "https",
        hostname: "**.brand.dev",
      },
    ],
  },
  turbopack: {
    rules: {
      "*.svg": {
        loaders: [
          {
            loader: "@svgr/webpack",
            options: {
              icon: true,
            },
          },
        ],
        as: "*.js",
      },
    },
  },
};

export default nextConfig;
