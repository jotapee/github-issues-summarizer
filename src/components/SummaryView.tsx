'use client';

import { useCallback, useState } from 'react';
import type { StoredResult } from '@/lib/types';

function download(filename: string, contents: string, mime: string) {
  const blob = new Blob([contents], { type: mime });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

/** Wraps the fragment the composer produced into a standalone HTML document. */
function standaloneHtml(result: StoredResult): string {
  const title = `${result.ref.owner}/${result.ref.repo} Issue TL;DR`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { max-width: 46rem; margin: 3rem auto; padding: 0 1.25rem;
         font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         color: #1a1d24; }
  h1 { font-size: 1.75rem; letter-spacing: -0.02em; }
  h2 { margin-top: 2.5rem; padding-bottom: .4rem; border-bottom: 1px solid #e3e6ec; }
  h3 { margin-top: 1.75rem; color: #2563eb; }
  em { color: #6b7280; font-style: normal; font-size: .875rem; }
  code { background: #f3f4f6; border-radius: 4px; padding: .1rem .35rem; font-size: .875em; }
  li { margin: .35rem 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #d7dbe4; }
    h2 { border-color: #262c3a; }
    h3 { color: #6ea8fe; }
    code { background: #191d27; }
  }
</style>
</head>
<body>
${result.summary.html}
</body>
</html>`;
}

export default function SummaryView({
  result,
  cached,
}: {
  result: StoredResult;
  cached: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const base = `${result.ref.owner}-${result.ref.repo}-tldr`;

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(result.summary.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [result.summary.markdown]);

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={copy}
          className="rounded-lg border border-ink-700 bg-ink-800/60 px-3.5 py-2 text-xs font-medium text-ink-200 transition hover:border-ink-400 hover:text-white"
        >
          {copied ? 'Copied' : 'Copy Markdown'}
        </button>
        <button
          onClick={() => download(`${base}.md`, result.summary.markdown, 'text/markdown')}
          className="rounded-lg border border-ink-700 bg-ink-800/60 px-3.5 py-2 text-xs font-medium text-ink-200 transition hover:border-ink-400 hover:text-white"
        >
          Download .md
        </button>
        <button
          onClick={() => download(`${base}.html`, standaloneHtml(result), 'text/html')}
          className="rounded-lg border border-ink-700 bg-ink-800/60 px-3.5 py-2 text-xs font-medium text-ink-200 transition hover:border-ink-400 hover:text-white"
        >
          Download .html
        </button>
        <span className="ml-auto text-xs text-ink-400">
          {cached ? 'Served from cache' : `${result.issueCount} issues read`}
        </span>
      </div>

      <article
        className="summary rounded-2xl border border-ink-700 bg-ink-900/60 p-6 sm:p-8"
        // Sanitized at render time in src/lib/markdown.ts: raw HTML is
        // escaped and link schemes are restricted, because the composer's
        // output derives from arbitrary GitHub issue text.
        dangerouslySetInnerHTML={{ __html: result.summary.html }}
      />
    </section>
  );
}
