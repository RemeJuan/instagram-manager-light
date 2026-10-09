const { withNx } = require("@nx/next/plugins/with-nx");

const hosted =
  process.env.HOSTED === "true" || process.env.NEXT_PUBLIC_HOSTED === "true";
const localLan = process.env.LOCAL_LAN === "true";
const publicLocalLan = process.env.NEXT_PUBLIC_LOCAL_LAN === "true";
const lanIp = process.env.LOCAL_LAN_IP || "";

if (localLan !== publicLocalLan)
  throw new Error("LOCAL_LAN and NEXT_PUBLIC_LOCAL_LAN must match.");
if (hosted && (localLan || publicLocalLan))
  throw new Error("Hosted mode cannot enable LOCAL_LAN.");

function isPrivateIpv4(value) {
  const octets = value.split(".");
  if (
    octets.length !== 4 ||
    octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
  )
    return false;
  const [a, b] = octets.map(Number);
  return (
    (a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)) &&
    octets.every((part) => String(Number(part)) === part)
  );
}

if (localLan) {
  if (hosted) throw new Error("LOCAL_LAN cannot be enabled in hosted mode.");
  if (!isPrivateIpv4(lanIp))
    throw new Error("LOCAL_LAN_IP must be a private RFC1918 IPv4 address.");
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@instagram-manager/contracts",
    "@instagram-manager/import-format",
    "@instagram-manager/relationship-core",
  ],
  async rewrites() {
    if (localLan)
      return [
        { source: "/api/:path*", destination: "http://127.0.0.1:3001/:path*" },
      ];
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
