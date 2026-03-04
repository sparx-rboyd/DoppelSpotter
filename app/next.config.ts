import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: ['@google-cloud/firestore', 'apify-client'],
};

export default nextConfig;
