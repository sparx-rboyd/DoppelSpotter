import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: ['@google-cloud/firestore', 'apify-client'],
  // proxy-agent is required dynamically by apify-client and is not auto-traced
  // by @vercel/nft — force-include it and its sub-agents in the standalone bundle.
  outputFileTracingIncludes: {
    '**': [
      './node_modules/proxy-agent/**/*',
      './node_modules/agent-base/**/*',
      './node_modules/http-proxy-agent/**/*',
      './node_modules/https-proxy-agent/**/*',
      './node_modules/pac-proxy-agent/**/*',
      './node_modules/socks-proxy-agent/**/*',
    ],
  },
};

export default nextConfig;
