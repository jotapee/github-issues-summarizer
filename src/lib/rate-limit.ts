import { getCloudflareContext } from '@opennextjs/cloudflare';

/**
 * Per-IP quota on cold pipeline runs, held in KV.
 *
 * This is the control that actually bounds spend. Token auth stops casual
 * abuse, but a token lifted from the page stays valid until it expires. The
 * quota is what stops that from becoming an unbounded OpenAI bill.
 *
 * Caveat: KV is eventually consistent and this is a read-then-write, so
 * simultaneous requests from one IP can both read the same count and slip a
 * request or two over the limit. That is fine for a spend guard. If you ever
 * need an exact counter, move this to a Durable Object.
 */

const WINDOW_SECONDS = 60 * 60;
/** Cold runs (the ones that cost money) allowed per IP per hour. */
export const COLD_RUNS_PER_HOUR = 5;

export interface Quota {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ??
    'unknown'
  );
}

async function getKV(): Promise<KVNamespace | null> {
  try {
    const { env } = getCloudflareContext();
    return (env as unknown as { TLDR_KV?: KVNamespace }).TLDR_KV ?? null;
  } catch {
    return null;
  }
}

/** Reads the current usage without consuming any. */
export async function checkQuota(request: Request): Promise<Quota> {
  const kv = await getKV();
  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const secondsIntoWindow = Math.floor(Date.now() / 1000) % WINDOW_SECONDS;
  const retryAfterSeconds = WINDOW_SECONDS - secondsIntoWindow;

  // No KV bound (e.g. the namespace id is still a placeholder), so fail open
  // rather than taking the whole app down, but this is worth fixing.
  if (!kv) return { allowed: true, remaining: COLD_RUNS_PER_HOUR, retryAfterSeconds };

  const key = `rl:${clientIp(request)}:${window}`;
  const used = Number((await kv.get(key)) ?? 0);
  const remaining = Math.max(0, COLD_RUNS_PER_HOUR - used);

  return { allowed: remaining > 0, remaining, retryAfterSeconds };
}

/**
 * Consumes one unit. Called only when a run actually reaches the LLM stages,
 * because cache hits are free and must not burn quota.
 */
export async function consumeQuota(request: Request): Promise<void> {
  const kv = await getKV();
  if (!kv) return;

  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const key = `rl:${clientIp(request)}:${window}`;
  try {
    const used = Number((await kv.get(key)) ?? 0);
    await kv.put(key, String(used + 1), { expirationTtl: WINDOW_SECONDS * 2 });
  } catch {
    // Never fail a request because the counter could not be written.
  }
}
