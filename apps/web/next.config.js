/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allows Next to pick up changes to the shared workspace package.
  transpilePackages: ['@session-replay/shared'],
};

module.exports = nextConfig;
