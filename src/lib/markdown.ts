import { Marked } from 'marked';

/**
 * The composer's Markdown is machine-generated from arbitrary GitHub issue
 * text, so it must be treated as untrusted: an issue titled
 * `<img src=x onerror=alert(1)>` can survive into the summary. marked does not
 * sanitize, so raw HTML is escaped into visible text and link targets are
 * restricted to safe schemes.
 */

const SAFE_SCHEME = /^(https?:|mailto:|#|\/)/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(href: string): string | null {
  // Strip whitespace and control characters, which can be used to smuggle
  // `java\nscript:` past a naive scheme check.
  const normalised = href.replace(/[\u0000-\u0020]/g, '');
  return SAFE_SCHEME.test(normalised) ? normalised : null;
}

const marked = new Marked({ gfm: true, breaks: false });

marked.use({
  renderer: {
    // Block-level and inline raw HTML both land here.
    html({ text }: { text: string }) {
      return escapeHtml(text);
    },
    link(this: { parser: { parseInline(tokens: unknown[]): string } }, token: {
      href: string;
      title?: string | null;
      tokens: unknown[];
    }) {
      const label = this.parser.parseInline(token.tokens);
      const safe = safeHref(token.href);
      if (!safe) return label;
      const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(safe)}"${titleAttr} rel="noopener noreferrer nofollow" target="_blank">${label}</a>`;
    },
    // Remote images are a tracking and layout risk in a generated summary;
    // render the alt text instead.
    image({ text }: { text: string }) {
      return escapeHtml(text);
    },
  },
});

export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false }) as string;
}
