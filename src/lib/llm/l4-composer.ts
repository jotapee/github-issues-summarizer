import { renderMarkdown } from '../markdown';
import type {
  CommentDigest,
  Issue,
  IssueDigest,
  RepoMeta,
  RepoRef,
  Summary,
  UpdateDelta,
} from '../types';
import { callJson } from './client';

const SYSTEM = `You are writing the TL;DR that a maintainer or a newcomer reads instead of scrolling the issue tracker.

You get per-issue digests and per-thread digests. Write Markdown with exactly these sections:

## TL;DR
Three to five sentences. What is the state of this issue tracker right now? Lead with the single most important thing. Name the dominant themes and say whether the tracker is healthy, backed up, or dominated by one problem. No bullet points here.

## Main themes
Three to six themes, each a "### " heading with the theme name. Under each: two or three sentences synthesising the issues in it, then a line "Issues: #12, #34, #56" listing the relevant numbers. Order themes by how much of the tracker they account for.

## Needs attention
A bulleted list of at most 8 issues that most warrant a human right now: high severity, blocked, or with an unanswered question. Format each as "- **#123**: one line on why it needs attention."

## Open questions
A bulleted list of at most 6 unresolved questions drawn from the discussions. Omit this section entirely if there are none.

Rules:
- Every issue number you cite must appear in the digests you were given. Never invent one.
- Synthesise across issues; do not restate digests one by one.
- Plain, direct prose. No filler, no "in conclusion", no hedging about being an AI.
- Never use em dashes. Use commas, colons, or separate sentences instead.
- Do not include a top-level "# " heading; the page adds its own.

Respond with JSON: {"markdown": "<the full markdown document>"}`;

function renderInput(bodyDigests: IssueDigest[], commentDigests: CommentDigest[]): string {
  const byNumber = new Map(
    commentDigests.filter((c) => !c.failed).map((c) => [c.number, c]),
  );
  return bodyDigests
    .map((d) => {
      const c = byNumber.get(d.number);
      const lines = [`#${d.number} [${d.kind}/${d.severity}] {${d.theme}} ${d.gist}`];
      if (c) {
        lines.push(`  discussion: ${c.discussion}`);
        if (c.consensus) lines.push(`  consensus: ${c.consensus}`);
        if (c.blockers.length) lines.push(`  blockers: ${c.blockers.join('; ')}`);
        if (c.openQuestions.length) lines.push(`  open: ${c.openQuestions.join('; ')}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function header(ref: RepoRef, meta: RepoMeta, issueCount: number): string {
  const facts = [
    meta.language ? `${meta.language}` : null,
    `${meta.stars.toLocaleString('en-US')} stars`,
    `${meta.openIssueCount.toLocaleString('en-US')} open issues`,
  ].filter(Boolean);

  return `# ${ref.owner}/${ref.repo} Issue TL;DR

${meta.description ?? '_No repository description._'}

*${facts.join(' · ')} · summarised from the ${issueCount} most recently updated open issues on ${new Date().toISOString().slice(0, 10)}*

`;
}

/** LLM 4, the composer. Produces the final Markdown, then the HTML rendering. */
export async function composeSummary(
  apiKey: string,
  ref: RepoRef,
  meta: RepoMeta,
  issues: Issue[],
  bodyDigests: IssueDigest[],
  commentDigests: CommentDigest[],
  delta?: UpdateDelta,
): Promise<Summary> {
  // Failed digests are recorded upstream but must never reach the reader.
  const usable = bodyDigests.filter((d) => !d.failed);
  const unavailable = bodyDigests.length - usable.length;
  const deltaNote = delta
    ? `\n\nThis is a refresh of an earlier summary. Recent movement to weave in:\n${delta.narrative}`
    : '';

  const raw = await callJson<{ markdown?: unknown }>({
    apiKey,
    stage: 'composer',
    system: SYSTEM,
    user: `Repository: ${ref.owner}/${ref.repo}
${meta.description ? `Description: ${meta.description}` : ''}
Open issues in tracker: ${meta.openIssueCount}. Digested here: ${usable.length}.${
      unavailable > 0
        ? ` (${unavailable} issue(s) could not be processed and are excluded.)`
        : ''
    }${deltaNote}

DIGESTS:
${renderInput(usable, commentDigests)}`,
    maxTokens: 4000,
    temperature: 0.4,
  });

  const body = String(raw.markdown ?? '').trim();
  if (!body) throw new Error('The composer returned an empty summary.');
  if (!usable.length) throw new Error('No issues could be summarised.');

  const markdown = header(ref, meta, issues.length) + body;
  const html = renderMarkdown(markdown);

  return { markdown, html };
}
