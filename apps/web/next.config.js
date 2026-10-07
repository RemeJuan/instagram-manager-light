const { withNx } = require("@nx/next/plugins/with-nx");

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@instagram-manager/contracts",
    "@instagram-manager/import-format",
    "@instagram-manager/relationship-core",
  ],
  async rewrites() {
    if (process.env.NEXT_PUBLIC_HOSTED !== "true") return [];
    const raw = process.env.API_UPSTREAM_URL;
    if (!raw) throw new Error("Hosted web requires API_UPSTREAM_URL.");
    const url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "API_UPSTREAM_URL must be an HTTP(S) origin without credentials or a path.",
      );
    }
    return [{ source: "/api/:path*", destination: `${url.origin}/:path*` }];
  },
  async headers() {
    if (process.env.NEXT_PUBLIC_HOSTED !== "true") return [];
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      },
      {
        source: "/invite",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        source: "/invite/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};
module.exports = withNx(nextConfig);
