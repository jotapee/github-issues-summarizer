import { getCloudflareContext } from '@opennextjs/cloudflare';

interface Env {
  GITHUB_TOKEN?: string;
  OPENAI_API_KEY?: string;
  AUTH_SECRET?: string;
}

/**
 * Reads a secret from the Worker environment, falling back to process.env so
 * the app also runs under a plain Node build.
 */
export async function readSecret(name: keyof Env): Promise<string | null> {
  let fromWorker: string | undefined;
  try {
    const { env } = getCloudflareContext();
    fromWorker = (env as unknown as Env)[name];
  } catch {
    // No Cloudflare context available.
  }
  return fromWorker ?? process.env[name] ?? null;
}

export function getAuthSecret(): Promise<string | null> {
  return readSecret('AUTH_SECRET');
}
