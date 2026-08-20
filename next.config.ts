import type { NextConfig } from 'next';

const nextConfig: NextConfig = {};

export default nextConfig;

// Makes Cloudflare bindings (KV, secrets) available during `next dev`.
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
initOpenNextCloudflareForDev();
