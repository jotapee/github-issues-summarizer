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

/**
 * Turns issue references such as `#1234` into links to the issue on GitHub.
 *
 * Nothing extra is stored to make this work: the URL is derived from the repo
 * reference already held on the record plus the issue number in the text.
 *
 * Only numbers present in `knownNumbers` are linked. That keeps the composer
 * honest (a number it invented cannot become a plausible-looking link) and
 * avoids false positives such as a hex colour like `#112233`.
 *
 * Text inside code spans and fenced blocks is left alone, as is any reference
 * the composer already wrote as a Markdown link.
 */
export function linkIssueRefs(
  markdown: string,
  repo: { owner: string; repo: string },
  knownNumbers: ReadonlySet<number>,
): string {
  if (!knownNumbers.size) return markdown;

  // Keep fenced blocks and inline code verbatim by splitting on them.
  const segments = markdown.split(/(```[\s\S]*?```|`[^`\n]*`)/g);

  return segments
    .map((segment, index) => {
      // Odd indices are the captured code segments.
      if (index % 2 === 1) return segment;

      return segment.replace(/(.?)#(\d+)\b/g, (match, before: string, digits: string) => {
        const number = Number(digits);
        if (!knownNumbers.has(number)) return match;
        // Already inside a Markdown link label, e.g. [#12](...).
        if (before === '[') return match;
        const url = `https://github.com/${repo.owner}/${repo.repo}/issues/${number}`;
        return `${before}[#${number}](${url})`;
      });
    })
    .join('');
}

/**
 * Removes em dashes from generated prose.
 *
 * The composer prompt asks the model not to use them, but a prompt is a
 * request, not a guarantee: models emit them anyway. House style forbids them,
 * so the rule is enforced here where it cannot be ignored. Surrounding
 * whitespace is absorbed so "activity\u2014no changes" and "activity \u2014 no
 * changes" both become "activity, no changes".
 */
export function stripEmDashes(text: string): string {
  return text.replace(/\s*[\u2014\u2015]\s*/g, ', ');
}
