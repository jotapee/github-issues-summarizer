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

/**
 * Guarantees that no issue number appears under more than one theme.
 *
 * The composer prompt states the rule plainly and mostly follows it, but not
 * reliably: across three repositories it still placed the odd issue in two
 * themes. The rule is mechanical, so it is enforced mechanically here. The
 * first theme to claim an issue keeps it, matching the prompt's instruction to
 * drop the number from the weaker theme.
 *
 * Operates on the composer's raw Markdown, before issue references are turned
 * into links, so it only has to match bare `#123` tokens.
 */
export function dedupeThemeIssues(markdown: string): {
  markdown: string;
  removed: Array<{ number: number; theme: string }>;
} {
  const start = markdown.indexOf('## Main themes');
  if (start === -1) return { markdown, removed: [] };

  const rest = markdown.slice(start + '## Main themes'.length);
  const endOffset = rest.search(/^## /m);
  const body = endOffset === -1 ? rest : rest.slice(0, endOffset);
  const tail = endOffset === -1 ? '' : rest.slice(endOffset);

  const seen = new Set<number>();
  const removed: Array<{ number: number; theme: string }> = [];
  let theme = '(unnamed)';

  const lines = body.split('\n').map((line) => {
    const heading = line.match(/^###\s+(.*)$/);
    if (heading) {
      theme = heading[1].trim();
      return line;
    }

    if (!/^\s*Issues:/i.test(line)) return line;

    const kept: string[] = [];
    for (const token of line.match(/#\d+/g) ?? []) {
      const number = Number(token.slice(1));
      if (seen.has(number)) {
        removed.push({ number, theme });
        continue;
      }
      seen.add(number);
      kept.push(token);
    }

    // A theme whose issues were all claimed earlier keeps its prose but loses
    // the now-empty list rather than rendering "Issues:" with nothing after it.
    return kept.length ? `Issues: ${kept.join(', ')}` : '';
  });

  return { markdown: markdown.slice(0, start) + '## Main themes' + lines.join('\n') + tail, removed };
}

/**
 * Theme names that describe severity, urgency, status or issue type rather
 * than a subject area. The composer prompt forbids these by name and mostly
 * complies, but not always, so they are detected and reported. They are not
 * rewritten: choosing a replacement name is a judgement call, and renaming a
 * heading the surrounding prose refers to would trade one incoherence for
 * another.
 */
const NON_SUBJECT_THEME =
  /\b(high[- ]severity|severity|critical|urgent|priority|blocked|stale|needs attention|bug fixes)\b/i;

export function findNonSubjectThemes(markdown: string): string[] {
  const start = markdown.indexOf('## Main themes');
  if (start === -1) return [];
  const rest = markdown.slice(start);
  const end = rest.slice('## Main themes'.length).search(/^## /m);
  const body = end === -1 ? rest : rest.slice(0, end + '## Main themes'.length);

  return (body.match(/^###\s+(.*)$/gm) ?? [])
    .map((line) => line.replace(/^###\s+/, '').trim())
    .filter((name) => NON_SUBJECT_THEME.test(name));
}
