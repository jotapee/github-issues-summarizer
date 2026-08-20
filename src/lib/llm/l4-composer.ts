import { linkIssueRefs, renderMarkdown, stripEmDashes } from '../markdown';
import type {
  CommentDigest,
  HealthScore,
  Issue,
  IssueDigest,
  RepoMeta,
  RepoRef,
  Summary,
  UpdateDelta,
} from '../types';
import { callJson } from './client';

const SYSTEM = `You are writing the assessment that a developer reads before depending on a repository. The question they are answering is "is this project being looked after, and what am I walking into".

You get a precomputed maintenance health score, per-issue digests and per-thread digests. Write Markdown with exactly these sections:

## Verdict
Two or three sentences answering whether this project is actively maintained and what a newcomer is walking into. State the score and grade exactly as given. Then justify it from the component breakdown: name the two components that cost the most points and the one that scored best, in plain language. Never recompute or adjust the score, and never invent component numbers. If a caveat is supplied, work the most important one into the prose rather than listing it.

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
- The health score, its grade and its component numbers are given to you as fact. Reproduce them exactly. Do not recalculate, round differently, or editorialise the number up or down.
- The score measures maintenance activity in the issue tracker. Never describe it as a judgement of code quality.
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

function header(
  ref: RepoRef,
  meta: RepoMeta,
  issueCount: number,
  health: HealthScore,
): string {
  const facts = [
    meta.language ? `${meta.language}` : null,
    `${meta.stars.toLocaleString('en-US')} stars`,
    `${meta.openIssueCount.toLocaleString('en-US')} open`,
    `${meta.closedIssueCount.toLocaleString('en-US')} closed`,
  ].filter(Boolean);

  const breakdown = health.components
    .map((c) => `| ${c.label} | ${c.earned} / ${c.max} | ${c.detail} |`)
    .join('\n');

  return `# ${ref.owner}/${ref.repo}

${meta.description ?? '_No repository description._'}

**Maintenance health: ${health.score}/100 (${health.grade})**

*${facts.join(' · ')} · read from the ${issueCount} most recently updated open issues on ${new Date().toISOString().slice(0, 10)}*

| Signal | Score | Basis |
| --- | --- | --- |
${breakdown}

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
  health: HealthScore,
  delta?: UpdateDelta,
): Promise<Summary> {
  // Failed digests are recorded upstream but must never reach the reader.
  const usable = bodyDigests.filter((d) => !d.failed);
  const unavailable = bodyDigests.length - usable.length;
  const deltaNote = delta
    ? `\n\nThis is a refresh of an earlier summary. Recent movement to weave in:\n${delta.narrative}`
    : '';

  const healthBlock = [
    `SCORE: ${health.score}/100 (grade ${health.grade})`,
    'COMPONENTS:',
    ...health.components.map(
      (c) => `  ${c.label}: ${c.earned} of ${c.max}. ${c.detail}`,
    ),
    'CAVEATS:',
    ...health.caveats.map((c) => `  ${c}`),
  ].join('\n');

  const raw = await callJson<{ markdown?: unknown }>({
    apiKey,
    stage: 'composer',
    system: SYSTEM,
    user: `Repository: ${ref.owner}/${ref.repo}
${meta.description ? `Description: ${meta.description}` : ''}
MAINTENANCE HEALTH (precomputed, reproduce exactly):
${healthBlock}

Open issues in tracker: ${meta.openIssueCount}. Closed all time: ${meta.closedIssueCount}. Digested here: ${usable.length}.${
      unavailable > 0
        ? ` (${unavailable} issue(s) could not be processed and are excluded.)`
        : ''
    }${deltaNote}

DIGESTS:
${renderInput(usable, commentDigests)}`,
    maxTokens: 4000,
    temperature: 0.4,
  });

  const body = stripEmDashes(String(raw.markdown ?? '').trim());
  if (!body) throw new Error('The composer returned an empty summary.');
  if (!usable.length) throw new Error('No issues could be summarised.');

  // Issue references become links to the source. Derived from `ref` plus the
  // number, so nothing extra needs storing, and restricted to issues we
  // actually digested so an invented number cannot become a link.
  const known = new Set(usable.map((d) => d.number));
  const markdown = header(ref, meta, issues.length, health) + linkIssueRefs(body, ref, known);
  const html = renderMarkdown(markdown);

  return { markdown, html };
}
