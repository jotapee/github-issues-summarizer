import { headers } from 'next/headers';
import TldrApp from '@/components/TldrApp';
import { mintToken } from '@/lib/auth';
import { getAuthSecret } from '@/lib/secrets';

// The token is minted per request and expires, so the page must never be
// cached as static HTML.
export const dynamic = 'force-dynamic';

export default async function Home() {
  const secret = await getAuthSecret();
  const host = (await headers()).get('host') ?? '';
  // AUTH_SECRET missing is a deployment error; the API reports it as a 503.
  const token = secret ? await mintToken(secret, host) : '';

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-5 py-12 sm:px-8 sm:py-20">
      <header className="mb-10">
        <p className="mb-3 text-xs font-medium uppercase tracking-[0.2em] text-ink-400">
          GitHub repository summary
        </p>
        <h1 className="text-4xl font-bold leading-[1.1] tracking-tight text-white sm:text-5xl">
          Every open issue,
          <br />
          <span className="text-accent">summarised in one page.</span>
        </h1>
        <p className="mt-5 max-w-xl text-base leading-relaxed text-ink-400">
          Paste any public GitHub repository. Its open issues and comment threads are read
          and condensed into a single briefing: the themes that dominate the tracker, what
          needs attention, what nobody has answered, and an overall status score for the
          repository.
        </p>
      </header>

      <TldrApp token={token} />

      <footer className="mt-auto pt-16 text-xs text-ink-400">
        Summaries are cached and refreshed incrementally, so running the same repo again only
        re-reads what changed.
      </footer>
    </main>
  );
}
