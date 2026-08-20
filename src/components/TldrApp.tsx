'use client';

import { useCallback, useRef, useState } from 'react';
import SummaryView from './SummaryView';
import type { PipelineEvent, StoredResult } from '@/lib/types';

interface Progress {
  stage: string;
  detail: string;
}

export default function TldrApp({ token }: { token: string }) {
  const [url, setUrl] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [result, setResult] = useState<StoredResult | null>(null);
  const [cached, setCached] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (running || !url.trim()) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setRunning(true);
      setProgress([]);
      setResult(null);
      setError(null);

      try {
        const response = await fetch('/api/tldr', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ url }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const fallback = (await response
            .json()
            .catch(() => null)) as { error?: string; code?: string } | null;
          if (fallback?.code === 'token_expired') {
            // The page mints a fresh token on load; reloading is the fix.
            window.location.reload();
            return;
          }
          throw new Error(fallback?.error ?? `Request failed (${response.status}).`);
        }

        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';

        // Parse the SSE frames as they arrive; a frame ends with a blank line.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;

          let split: number;
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);

            const payload = frame
              .split('\n')
              .filter((line) => line.startsWith('data: '))
              .map((line) => line.slice(6))
              .join('');
            if (!payload) continue;

            const parsed = JSON.parse(payload) as PipelineEvent;
            if (parsed.type === 'stage') {
              setProgress((prev) => [...prev, { stage: parsed.stage, detail: parsed.detail }]);
            } else if (parsed.type === 'done') {
              setResult(parsed.result);
              setCached(parsed.cached);
            } else if (parsed.type === 'error') {
              setError(parsed.message);
            }
          }
        }
      } catch (caught) {
        if ((caught as Error).name !== 'AbortError') {
          setError((caught as Error).message);
        }
      } finally {
        setRunning(false);
      }
    },
    [running, url, token],
  );

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor="repo-url" className="sr-only">
          GitHub repository URL
        </label>
        <input
          id="repo-url"
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/vercel/next.js"
          autoComplete="off"
          spellCheck={false}
          disabled={running}
          className="min-w-0 flex-1 rounded-xl border border-ink-700 bg-ink-900/80 px-4 py-3.5 text-[15px] text-white outline-none transition placeholder:text-ink-400/70 focus:border-accent focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={running || !url.trim()}
          className="rounded-xl bg-accent-strong px-6 py-3.5 text-[15px] font-semibold text-white transition hover:bg-accent-strong/85 focus:outline-none focus:ring-2 focus:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running ? 'Working…' : 'Summarise'}
        </button>
      </form>

      {progress.length > 0 && (
        <ol className="flex flex-col gap-2.5" aria-live="polite">
          {progress.map((step, index) => {
            const isLast = index === progress.length - 1;
            const pending = running && isLast;
            return (
              <li
                key={`${step.stage}-${index}`}
                className={`flex items-start gap-3 text-sm ${
                  pending ? 'text-white' : 'text-ink-400'
                }`}
              >
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    pending ? 'animate-pulse bg-accent' : 'bg-ink-700'
                  }`}
                  aria-hidden
                />
                <span>{step.detail}</span>
              </li>
            );
          })}
        </ol>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3.5 text-sm text-red-200"
        >
          {error}
        </p>
      )}

      {result && <SummaryView result={result} cached={cached} />}
    </div>
  );
}
