const { withNx } = require("@nx/next/plugins/with-nx");

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@instagram-manager/contracts",
    "@instagram-manager/import-format",
    "@instagram-manager/relationship-core",
  ],
};
module.exports = withNx(nextConfig);
