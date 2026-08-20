/**
 * Request authentication for /api/tldr.
 *
 * The page mints a short-lived token signed with AUTH_SECRET and hands it to
 * the browser; the API verifies the signature before doing any paid work.
 *
 * IMPORTANT. What this does and does not buy you:
 *   It stops drive-by scripts, scrapers and anyone hitting the endpoint
 *   directly. It does NOT stop a determined person: they can load the page,
 *   read the minted token out of the HTML, and replay it until it expires.
 *   That is unavoidable for a public site with no login, because the browser must be
 *   given *something* to send. The per-IP quota in rate-limit.ts is what
 *   actually bounds spend in that case.
 *
 * AUTH_SECRET itself never leaves the server.
 */

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const VERSION = 'v1';

function toBase64Url(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Returns a plain ArrayBuffer so the result is usable as a BufferSource. */
function fromBase64Url(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buffer;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Bind the token to the host it was issued for, so it cannot be replayed elsewhere. */
function payload(expiresAt: number, host: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(`${VERSION}.${expiresAt}.${host}`);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function mintToken(secret: string, host: string): Promise<string> {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, payload(expiresAt, host));
  return `${VERSION}.${expiresAt}.${toBase64Url(signature)}`;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'expired' | 'bad-signature' };

export async function verifyToken(
  token: string | null,
  secret: string,
  host: string,
): Promise<VerifyResult> {
  if (!token) return { ok: false, reason: 'missing' };

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };

  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'malformed' };
  // Check the signature before trusting the expiry, so an attacker cannot
  // learn anything by editing the timestamp.

  let signature: ArrayBuffer;
  try {
    signature = fromBase64Url(parts[2]);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const key = await importKey(secret);
  // crypto.subtle.verify is constant-time.
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    payload(expiresAt, host),
  );
  if (!valid) return { ok: false, reason: 'bad-signature' };
  if (Date.now() > expiresAt) return { ok: false, reason: 'expired' };

  return { ok: true };
}

/**
 * Rejects cross-site calls. A browser cannot forge Origin, so this blocks
 * another site from driving your endpoint with a token lifted from your page.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // Same-origin GETs and non-browser callers omit it.
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
