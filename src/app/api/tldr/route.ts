import { isSameOrigin, verifyToken } from '@/lib/auth';
import { PipelineError, runPipeline } from '@/lib/pipeline';
import { parseRepoInput } from '@/lib/repo-url';
import { readStored } from '@/lib/storage';
import { COLD_RUNS_PER_HOUR, checkQuota, consumeQuota } from '@/lib/rate-limit';
import { getAuthSecret } from '@/lib/secrets';
import type { PipelineEvent } from '@/lib/types';

export const dynamic = 'force-dynamic';
/** The chain of four LLM calls can take a couple of minutes on a big repo. */
export const maxDuration = 300;

function sse(event: PipelineEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: Request) {
  // --- Gate 1: cross-site calls. ---
  if (!isSameOrigin(request)) {
    return Response.json({ error: 'Cross-origin requests are not allowed.' }, { status: 403 });
  }

  // --- Gate 2: signed token. ---
  const secret = await getAuthSecret();
  if (!secret) {
    return Response.json(
      { error: 'AUTH_SECRET is not configured on the server.' },
      { status: 503 },
    );
  }

  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const verdict = await verifyToken(token, secret, new URL(request.url).host);

  if (!verdict.ok) {
    // `expired` is the one case the browser can fix by itself, so name it
    // distinctly, so the client can reload the page to get a fresh token.
    const expired = verdict.reason === 'expired';
    return Response.json(
      {
        error: expired
          ? 'Your session expired. Reload the page and try again.'
          : 'Unauthorized.',
        code: expired ? 'token_expired' : 'unauthorized',
      },
      { status: 401 },
    );
  }

  let url: string;
  try {
    const body = (await request.json()) as { url?: unknown };
    url = String(body.url ?? '').trim();
  } catch {
    return Response.json({ error: 'Expected a JSON body with a "url" field.' }, { status: 400 });
  }

  if (!url) {
    return Response.json({ error: 'Paste a GitHub repository URL first.' }, { status: 400 });
  }

  // --- Gate 3: per-IP quota, but only on work that actually costs money. ---
  // A repo we have already summarised is free to serve, so being over quota
  // must not block it. Only refuse outright when there is nothing cached and
  // the request would therefore hit GitHub and the models.
  const quota = await checkQuota(request);
  if (!quota.allowed) {
    const ref = parseRepoInput(url);
    const stored = ref ? await readStored(ref.slug) : null;
    if (!stored) {
      return Response.json(
        {
          error: `Rate limit reached: ${COLD_RUNS_PER_HOUR} new summaries per hour. Repositories already summarised still work.`,
        },
        { status: 429, headers: { 'Retry-After': String(quota.retryAfterSeconds) } },
      );
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: PipelineEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(sse(event)));
      };

      try {
        const { result, cached } = await runPipeline(url, send, {
          allowPaidWork: quota.allowed,
        });
        // Cache hits cost nothing, so they must not burn quota.
        if (!cached) await consumeQuota(request);
        send({ type: 'done', result, cached });
      } catch (error) {
        const message =
          error instanceof PipelineError
            ? error.message
            : `Something went wrong: ${(error as Error).message}`;
        send({ type: 'error', message });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
