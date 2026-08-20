import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { StoredResult } from './types';

// Bumped to v2 when `digests` was renamed to `bodyDigests` (DESIGN.md section 5).
const PREFIX = 'tldr:v2:';
/** Cached summaries expire after a week even if nobody refreshes them. */
const TTL_SECONDS = 60 * 60 * 24 * 7;

interface Env {
  TLDR_KV?: KVNamespace;
  GITHUB_TOKEN?: string;
  OPENAI_API_KEY?: string;
}

export async function getEnv(): Promise<Env> {
  const { env } = getCloudflareContext();
  return env as unknown as Env;
}

async function getKV(): Promise<KVNamespace | null> {
  try {
    const env = await getEnv();
    return env.TLDR_KV ?? null;
  } catch {
    // No Cloudflare context (e.g. a plain node build), so run without a cache.
    return null;
  }
}

export async function readStored(slug: string): Promise<StoredResult | null> {
  const kv = await getKV();
  if (!kv) return null;
  try {
    return await kv.get<StoredResult>(PREFIX + slug, 'json');
  } catch {
    return null;
  }
}

export async function writeStored(result: StoredResult): Promise<void> {
  const kv = await getKV();
  if (!kv) return;
  try {
    await kv.put(PREFIX + result.slug, JSON.stringify(result), {
      expirationTtl: TTL_SECONDS,
    });
  } catch {
    // A cache write failure must never fail the request.
  }
}
